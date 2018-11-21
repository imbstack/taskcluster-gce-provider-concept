const {google} = require('googleapis');
const debug = require('debug')('gce-provider');
const App = require('taskcluster-lib-app');
const loader = require('taskcluster-lib-loader');
const docs = require('taskcluster-lib-docs');
const SchemaSet = require('taskcluster-lib-validate');
const config = require('typed-env-config');
const _ = require('lodash');
const builder = require('./api');

const sleep = function(delay) {
  return new Promise(function(accept) {
    setTimeout(accept, delay);
  });
};

// Create component loader
const load = loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => config({profile}),
  },

  schemaset: {
    requires: ['cfg'],
    setup: ({cfg}) => new SchemaSet({
      serviceName: 'todo',
      publish: false,
    }),
  },

  oauthclient: {
    requires: ['cfg'],
    setup: ({cfg}) => new google.auth.OAuth2(),
  },

  createTypes: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      // TODO: This is a temporary thing to create workergroups on
      // startup from configuration directly!

      const auth = await google.auth.getClient({
        scopes: [
          'https://www.googleapis.com/auth/compute',
          'https://www.googleapis.com/auth/iam',
          'https://www.googleapis.com/auth/cloud-platform',
        ],
      });
      const project = cfg.app.project;
      const compute = google.compute('v1');
      const iam = google.iam('v1');
      const crm = google.cloudresourcemanager('v1');

      await Promise.all(cfg.app.workerTypes.map(async type => {
        // Check that the image exists
        await compute.images.get({
          auth,
          project,
          image: type.image,
        });

        const accountName = `workertype-${type.name}`;
        const accountEmail = `${accountName}@${project}.iam.gserviceaccount.com`;
        let account;

        try {
          account = (await iam.projects.serviceAccounts.get({
            auth,
            name: `projects/${project}/serviceAccounts/${accountEmail}`,
          })).data;
        } catch (err) {
          if (err.code !== 404) {
            throw err;
          }
          account = (await iam.projects.serviceAccounts.create({
            auth,
            name: `projects/${project}`,
            accountId: accountName,
            requestBody: {
              serviceAccount: {
                displayName: 'Taskcluster Workergroup: GCP Worker Test',
              },
            },
          })).data;
        }

        const roleId = `workertype.${type.name.replace(/-/g, '_')}`;
        let role;

        try {
          role = (await iam.projects.roles.get({
            auth,
            name: `projects/${project}/roles/${roleId}`,
          })).data;
          // TODO: Patch here if updated needed
        } catch (err) {
          if (err.code !== 404) {
            throw err;
          }
          role = (await iam.projects.roles.create({
            auth,
            parent: `projects/${project}`,
            requestBody: {
              roleId,
              role: {},
            },
          })).data;
        }

        const policy = (await crm.projects.getIamPolicy({
          auth,
          resource: project,
          requestBody: {},
        })).data;

        policy.bindings.push({
          role: `projects/${project}/roles/${roleId}`,
          members: [`serviceAccount:${account.email}`],
        });

        policy.bindings.push({
          role: 'roles/logging.logWriter',
          members: [`serviceAccount:${account.email}`],
        });

        policy.bindings.push({
          role: 'roles/monitoring.metricWriter',
          members: [`serviceAccount:${account.email}`],
        });

        await crm.projects.setIamPolicy({
          auth,
          resource: project,
          requestBody: {
            policy,
          },
        });

        // TODO: Make this clean up old templates somehow?
        // ALSO TODO: Consider just serving this directly and pointing the instance group template
        // at it via a url
        const templateName = `${type.name}-${type.version}`; // Bump version when you change any inputs or this template
        let templateLink;
        try {
          templateLink = (await compute.instanceTemplates.get({
            auth,
            project,
            instanceTemplate: templateName,
          })).data.selfLink;
        } catch (err) {
          if (err.code !== 404) {
            throw err;
          }
          // TODO: Get most of this from config
          let operation = (await compute.instanceTemplates.insert({
            auth,
            project,
            requestBody: {
              name: templateName,
              properties: {
                serviceAccounts: [
                  {
                    email: account.email,
                  },
                ],
                scheduling: {
                  preemptible: true,
                },
                machineType: 'n1-standard-2',
                networkInterfaces: [
                  {
                    accessConfigs: [
                      {type: 'ONE_TO_ONE_NAT'},
                    ],
                  },
                ],
                metadata: {
                  items: [
                    {
                      key: 'config',
                      value: JSON.stringify({
                        provisionerId: cfg.app.provisionerId,
                        workerType: type.name,
                        workerGroup: type.workerGroup,
                        credentialUrl: cfg.app.credentialUrl,
                        audience: cfg.app.audience,
                        configMap: type.configMap,
                      }),
                    },
                  ],
                },
                disks: [
                  {
                    type: 'PERSISTENT',
                    boot: true,
                    mode: 'READ_WRITE',
                    autoDelete: true,
                    initializeParams: {
                      sourceImage: `global/images/${type.image}`,
                      diskSizeGb: type.diskSizeGb,
                    },
                  },
                ],
              },
            },
          })).data;

          for (let i = 0; i < 10; i++) {
            debug('polling for template creation');
            operation = (await compute.globalOperations.get({
              auth,
              project,
              operation: operation.name,
            })).data;
            if (operation.status === 'DONE') {
              templateLink = operation.targetLink;
              break;
            }
            await sleep(2000);
          }
        }

        if (!templateLink) {
          throw new Error(`template ${templateName} never finished being created!`);
        }

        await Promise.all(type.zones.map(async zone => {
          // TODO: Add requestId to insert
          const groupName = `${type.name}-${zone}`;
          let group;
          try {
            group = (await compute.instanceGroupManagers.get({
              auth,
              project,
              zone,
              instanceGroupManager: groupName,
            })).data;
            // TODO: Update if something changed
          } catch (err) {
            if (err.code !== 404) {
              throw err;
            }
            let operation = (await compute.instanceGroupManagers.insert({
              auth,
              project,
              zone,
              requestBody: {
                name: groupName,
                instanceTemplate: templateLink,
                baseInstanceName: type.name,
                targetSize: type.instances,
              },
            })).data;
            // TODO: Poll this operation, assign group when done and also throw
            //       an error if we encounter an error during the operation
          }
        }));
      }));
    },
  },

  docs: {
    requires: ['cfg', 'schemaset'],
    setup: async ({cfg, schemaset}) => await docs.documenter({
      credentials: cfg.taskcluster.credentials,
      tier: 'integrations',
      publish: false,
      schemaset,
      references: [
        {
          name: 'api',
          reference: builder.reference(),
        },
      ],
    }),
  },

  writeDocs: {
    requires: ['docs'],
    setup: ({docs}) => docs.write({docsDir: process.env['DOCS_OUTPUT_DIR']}),
  },

  api: {
    requires: ['cfg', 'schemaset', 'oauthclient'],
    setup: ({cfg, schemaset, oauthclient}) => builder.build({
      rootUrl: cfg.taskcluster.rootUrl,
      schemaset,
      context: {
        oauthclient,
        credentials: cfg.taskcluster.credentials,
        audience: cfg.app.audience,
        project: cfg.app.project,
        provisionerId: cfg.app.provisionerId,
      },
    }),
  },

  server: {
    requires: ['cfg', 'api', 'docs'],
    setup: ({cfg, api, docs}) => App({
      ...cfg.server,
      apis: [api],
    }),
  },

}, ['profile', 'process']);

// If this file is executed launch component from first argument
if (!module.parent) {
  load(process.argv[2], {
    process: process.argv[2],
    profile: process.env.NODE_ENV,
  }).catch(err => {
    console.log(err.stack);
    process.exit(1);
  });
}

// Export load for tests
module.exports = load;

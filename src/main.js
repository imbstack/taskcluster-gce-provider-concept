const slugid = require('slugid');
const {google} = require('googleapis');
const debug = require('debug')('gce-provider');
const App = require('taskcluster-lib-app');
const loader = require('taskcluster-lib-loader');
const docs = require('taskcluster-lib-docs');
const SchemaSet = require('taskcluster-lib-validate');
const config = require('typed-env-config');
const _ = require('lodash');
const builder = require('./api');

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

  creategroups: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      // TODO: This is a temporary thing to create workergroups on
      // startup from configuration directly!

      // FIRST SET GCLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS // In prod this will come from machine directly
      const auth = await google.auth.getClient({
        scopes: [
          'https://www.googleapis.com/auth/compute',
          'https://www.googleapis.com/auth/iam',
          'https://www.googleapis.com/auth/cloud-platform'
        ],
      });
      const project = 'bstack-cluster'; // TODO: get this from config
      const compute = google.compute('v1');
      const iam = google.iam('v1');
      const crm = google.cloudresourcemanager('v1');

      let serviceAccounts = (await iam.projects.serviceAccounts.list({
        auth,
        name: `projects/${project}`,
      })).data.accounts;

      await Promise.all(cfg.workerGroups.map(async group => {
        // Check that the image exists
        await compute.images.get({
          auth,
          project,
          image: group.image,
        });

        const accountName = `workergroup-${group.name}`;
        const accountEmail = `${accountName}@${project}.iam.gserviceaccount.com`;
        let account;

        serviceAccounts.forEach(acc => {
          if (acc.email === accountEmail) {
            account = acc;
          }
        });

        if (!account) {
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

        const roleId = `workergroup.${group.name.replace(/-/g, '_')}`;
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
          role: `roles/logging.logWriter`,
          members: [`serviceAccount:${account.email}`],
        });

        policy.bindings.push({
          role: `roles/monitoring.metricWriter`,
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
        const templateName = `${group.name}-${slugid.nice().toLowerCase().replace(/_/, '-')}`;
        let template;
        try {
          template = (await compute.instanceTemplates.get({
            auth,
            project,
            instanceTemplate: templateName,
          })).data;
        } catch (err) {
          if (err.code !== 404) {
            throw err;
          }
          template = (await compute.instanceTemplates.insert({
            auth,
            project,
            requestBody: {
              name: templateName,
              properties: {
                serviceAccounts: [
                  {
                    email: account.email,
                  }
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
                        provisionerId: 'gcp-worker-test',
                        workerType: 'gcp-worker-test',
                        workerGroup: 'gcp-worker-test',
                        credentialUrl: '...',
                        audience: '...',
                        configMap: {
                          authBaseUrl: 'https://taskcluster-staging.net/api/auth/v1',
                          queueBaseUrl: 'https://taskcluster-staging.net/api/queue/v1',
                          signingKeyLocation: '/home/taskcluster/signing.key',
                          livelogSecret: 'foobar',
                          cachesDir: '/home/taskcluster/caches',
                          disableReboots: true,
                          shutdownMachineOnIdle: false,
                          shutdownMachineOnInternalError: false,
                          tasksDir: '/home/taskcluster'
                        },
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
                      sourceImage: `global/images/${group.image}`,
                      diskSizeGb: 32, // TODO: configurable
                    },
                  },
                ],
              },
            },
          })).data;
        }

        await Promise.all(group.zones.map(async zone => {
          // TODO: Do not create if already exists
          // TODO: Add requestId to insert
          let manager;
          manager = (await compute.instanceGroupManagers.insert({
            auth,
            project,
            zone,
            requestBody: {
              name: `${group.name}-${zone}`,
              instanceTemplate: template.selfLink,
              baseInstanceName: group.name,
              targetSize: group.instances,
            },
          })).data;
          console.log(manager);
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

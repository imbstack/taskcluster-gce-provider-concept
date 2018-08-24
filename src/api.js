const taskcluster = require('taskcluster-client');
const APIBuilder = require('taskcluster-lib-api');
const debug = require('debug')('gce-provider');
const jwt = require('jsonwebtoken');

const builder = new APIBuilder({
  title: 'GCE Provider Test',
  serviceName: 'gce-provider',
  version: 'v1',
  description: 'TODO',
  context: [
    'oauthclient',
    'credentials',
    'audience',
    'project',
    'provisionerId',
  ],
});

module.exports = builder;

builder.declare({
  method: 'post',
  route: '/credentials',
  name: 'getCredentials',
  title: 'Get Credentials from an Instance Identity Token',
  description: 'TODO',
}, async function(req, res) {
  const ticket = await this.oauthclient.verifyIdToken({
    idToken: req.body.token,
    audience: this.audience,
  });
  console.log(ticket);
  // TODO: Make sure that this throws an error when the token is bad
  // TODO: catch the error, log it, and send back a more opaque response

  const body = jwt.decode(req.body.token);
  console.log(body);

  const project = body.google.compute_engine.project_id;

  if (project !== this.project) {
    throw new Error(`Project is incorrect: ${project}`);
  }

  const re = /^workergroup-([a-zA-Z0-9-_]+)@[a-zA-Z0-9-_]+\.iam\.gserviceaccount\.com$/;

  const result = re.exec(body.email);
  if (!result) {
    throw new Error('TODO error');
  }

  // TODO: Store instance id and don't allow giving creds to same instance twice!

  const workertype = result[1];

  // TODO: use the contents of the token to verify instance is in
  // a group this has created. _or_ when setting up service accounts make sure that only this
  // service can manage them
  const creds = taskcluster.createTemporaryCredentials({
    clientId: `worker/gce/${project}/${body.google.compute_engine.instance_id}`,
    scopes: [
      `assume:worker-type:${this.provisionerId}/${workertype}`,
      'assume:worker-id:*',
    ],
    start: taskcluster.fromNow('-1 hours'), // TODO: remove this. it is for weird skew
    expiry: taskcluster.fromNow('24 hours'),
    credentials: this.credentials,
  });

  res.reply(creds);
});

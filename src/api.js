const taskcluster = require('taskcluster-client');
const APIBuilder = require('taskcluster-lib-api');
const debug = require('debug')('gce-provider');
const jwt = require('jsonwebtoken');

const builder = new APIBuilder({
  title: 'GCE Provider Test',
  serviceName: 'gce-provider-test',
  version: 'v1',
  description: 'TODO',
  context: [
    'oauthclient',
    'credentials',
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
    audience: 'taskclustertestsecret',
  });
  console.log(ticket);
  // TODO: Make sure that this throws an error when the token is bad
  // TODO: catch the error, log it, and send back a more opaque response

  const body = jwt.decode(req.body.token);
  console.log(body);

  const re = /^workergroup-([a-zA-Z0-9-_]+)@[a-zA-Z0-9-_]+\.iam\.gserviceaccount\.com$/;

  const result = re.exec(body.email);
  if (!result) {
    throw new Error('TODO error');
  }

  // TODO: Asser that this is from our project this is managing!

  const workergroup = result[1];

  // TODO: use the contents of the token to verify instance is in
  // a group this has created
  const creds = taskcluster.createTemporaryCredentials({
    clientId: `worker/gce/${body.google.compute_engine.project_id}/${body.google.compute_engine.instance_id}`,
    scopes: [
      `assume:worker-type:gcp-worker-test/${workergroup}`, // TODO: configure provisioner
      'assume:worker-id:*',
    ],
    start: taskcluster.fromNow('-10 hours'), // TODO: remove this. it is for weird skew
    expiry: taskcluster.fromNow('24 hours'),
    credentials: this.credentials,
  });

  res.reply(creds);
});

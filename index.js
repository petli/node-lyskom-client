/* LysKOM protocol A client library
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var net = require('net');
var Promise = require('bluebird');

var errors = require('./lib/errors');
var protocol = require('./lib/protocol');
var Client = require('./lib/client');

//
// Main interface
//

/** Connect to a LysKOM server.
 *
 * options:
 *  - host: server host (default 'localhost')
 *  - port: server port (default 4894)
 *
 * Return:
 *  - Client object, which will emit 'connect' when it is ready to be used.
 */
var connect = exports.connect = function(options) {
    if (!options.port) {
        options.port = 4894;
    }

    return new Client(net.connect(options));
};


/** Connect to a LysKOM server and wait for the connection to be ready.
 *
 * See connect() for the options.
 *
 * Return:
 *  - Bluebird Promise, which resolves to the Client object when it
 *    has connected and is ready to be used
 */
exports.connectAndWait = function(options) {
    return new Promise(function(resolve, reject) {
        var client = connect(options);

        client.on('error', reject);
        client.once('connect', function() {
            client.removeListener('error', reject);
            resolve(client);
        });
    });
};


//
// Expose error classes
//

exports.ProtocolError = errors.ProtocolError;
exports.ServerError = errors.ServerError;
exports.ClientError = errors.ClientError;
exports.RequestError = errors.RequestError;


/** List all implemented requests.
 */
exports.rpc = {};
for (var name in protocol.rpc) {
    if (protocol.rpc.hasOwnProperty(name)) {
        exports.rpc[name] = true;
    }
}

/** Map of async message names to numbers and vice versa to support
 * usage of Client.acceptAsync/queryAsync.
 *
 * Names are exposed both in protocol form (foo-bar) and camel cased (fooBar)
 */
exports.async = {};

var camelCaseName = function(name) {
    return name.replace(/-[a-z]/g, function(s) { return s[1].toUpperCase(); });
};

for (var num in protocol.async) {
    if (protocol.async.hasOwnProperty(num)) {
        var a = protocol.async[num];
        exports.async[num] = a.name;
        exports.async[a.name] = exports.async[camelCaseName(a.name)] = parseInt(num, 10);
    }
}

// Expose aux item tags as is
exports.aux = protocol.aux;

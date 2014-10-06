/* LysKOM protocol A client library
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var net = require('net');
var Promise = require('bluebird');

var Client = require('./lib/client');

/** connect(options)
 *
 * Connect to a LysKOM server.
 *
 * options:
 *  - host: server host (default 'localhost')
 *  - port: server port (default 4894)
 *
 * Return:
 *  - Bluebird promise that resolves to the new Client object
 */
module.exports = function(options) {
    if (!options.port) {
        options.port = 4894;
    }

    return new Promise(function(resolve, reject) {
        var socket = net.connect(options);

        socket.on('error', reject);
        socket.once('connect', function() {
            socket.removeListener('error', reject);
            resolve(new Client(socket));
        });
    });
};

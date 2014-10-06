/* LysKOM protocol A client object
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var debug = require('debug')('lyskom-client:client'); // jshint ignore:line

var util = require('util');
var events = require('events');
var Promise = require('bluebird');

var TokenStream = require('./tokenstream');
var protocol = require('./protocol');
var errors = require('./errors');

/** LysKOM Client implementation.
 */
var Client = function(socket) {
    this._socket = socket;
    this._tokenstream = new TokenStream(socket, true);

    this._state = 'connecting';

    this._nextRefNo = 0;
    this._requests = {}; // map from refNo to request info

    this._currentRequest = null; // currently parsed request info
    this._currentParser = null; // current parser instance, if any
    this._currentTarget = null; // resolve/reject/emit function

    // If we don't get enough tokens in one go to figure out what to
    // do next, keep track of the previous ones and how many more we need
    this._bufferedTokens = null;
    this._requiredTokens = 0;

    // Wire up events
    this._socket.on('error', this._onError.bind(this));
    this._socket.once('connect', this._onConnect.bind(this));
    this._socket.on('drain', this._onSocketDrain.bind(this));
    this._socket.on('close', this._onSocketClose.bind(this));

    this._tokenstream.on('error', this._onError.bind(this));
    this._tokenstream.once('handshake', this._onHandshake.bind(this));
    this._tokenstream.on('tokens', this._onTokens.bind(this));
    this._tokenstream.on('end', this._onEndOfTokens.bind(this));
};

util.inherits(Client, events.EventEmitter);

module.exports = Client;

/** Close the client connection.
 *
 * Any unsent requests will be sent and the responses
 * processed before the socket is fully closed.
 */
Client.prototype.close = function() {
    // TODO: don't close if there's queued unsent data
    if (this._state !== 'closed') {
        debug('closing socket');

        this._state = 'closed';
        if (this._socket) {
            this._socket.end();
        }
    }
};

/** Client event: error
 *
 * Emitted on connection-level errors.  The client connection will be
 * closed.
 *
 * Any emitted error will also reject all pending requests.
 *
 * Request-specific errors are not emitted as 'error' events.  They
 * only cause the corresponding request to be rejected.
 */
Client.prototype._onError = function(err) {
    debug('error: %s', err);

    // Shut down and reject all pending requests, since the
    // probability is very high that this is unrecoverable.  In
    // theory, some ServerErrors could allow us to keep running, but
    // they should only happen if there's a bug in this code, and then
    // we can't trust ourselves anyway.

    if (this._socket) {
        this._socket.destroy();
        this._socket = null;
    }
    this._tokenstream.removeAllListeners();
    this._tokenstream = null;

    this.emit('closed');
    this._state = 'closed';

    this.emit('error', err);

    if (this._currentRequest) {
        this._currentRequest.reject(err);
        this._currentRequest = null;
    }

    for (var refNo in this._requests) {
        if (this._requests.hasOwnProperty(refNo)) {
            var req = this._requests[refNo];
            debug('%s(%s): %s', req.name, refNo, err);
            req.reject(err);
        }
    }

    this._requests = {};
};


Client.prototype._onConnect = function() {
    debug('connected to server, sending handshake');

    var user = process.env.USER || 'node';
    var host = this._socket.localAddress;
    var connInfo = new Buffer(user + '%' + host);
    var handshake = Buffer.concat([new Buffer('A' + connInfo.length + 'H'), connInfo, new Buffer('\n')]);

    this._socket.write(handshake);
};


Client.prototype._onSocketDrain = function() {
    // TODO: do we need to wait on this before sending more?
};


/** Client event: close
 *
 * Emitted when the underlying socket have closed.
 */
Client.prototype._onSocketClose = function() {
    debug('connection closed');
    if (this._socket) {
        this._socket.removeAllListeners();
        this._socket = null;
    }
    this._state = 'closed';
    this.emit('close');
};


/** Client event: connect
 *
 * Emitted when the client has connected to the server and completed
 * the protocol handshake.  The client can now be used to send
 * requests.
 */
Client.prototype._onHandshake = function() {
    debug('handshake complete');
    this._state = 'open';
    this.emit('connect');
};


Client.prototype._onTokens = function(tokens) {
    if (this._requiredTokens > 0) {
        // Didn't get enough in the last call, so retry
        tokens = this._bufferedTokens.concat(tokens);

        if (tokens.length < this._requiredTokens)
        {
            // Not enough data to do anything useful yet
            debug('still waiting for %s tokens, got %s', this._requiredTokens, tokens.length);
            this._bufferedTokens = tokens;
            return;
        }
        else {
            // Got all we need to keep parsing
            this._requiredTokens = 0;
        }
    }

    while (tokens && tokens.length) {
        if (this._currentParser) {
            tokens = this._parseMessage(tokens);
        }
        else {
            // Buffer the tokens, in case we need to retry
            this._bufferedTokens = tokens;

            switch (tokens[0].type) {
            case '=':
                tokens = this._parseResponse(tokens);
                break;

            case '%':
                tokens = this._parseError(tokens);
                break;


            case ':':
                tokens = this._parseAsync(tokens);
                break;

            default:
                return this._protocolError('expected one of "=%%:", got: ' + tokens[0].type);
            }

            if (this._requiredTokens > 0) {
                debug('waiting for %s tokens, got %s', this._requiredTokens, this._bufferedTokens.length);
            }
            else {
                // didn't need any more tokens, forget the buffered ones
                this._bufferedTokens = null;
            }
        }
    }
};


Client.prototype._onEndOfTokens = function() {
    if (this._currentParser || this._requiredTokens > 0) {
        this._protocolError('unexpected end of data');
    }
};


Client.prototype._parseMessage = function(tokens) {
    var remaining;

    try {
        remaining = this._currentParser.parseTokens(tokens);
    }
    catch (err) {
        if (!(err instanceof errors.ProtocolError)) {
            throw err;
        }

        this._onError(err);
        return;
    }

    if (remaining === null) {
        // It gobbled up all tokens, so keep feeding it more
        return null;
    }

    // All done
    this._currentTarget(this._currentParser.getMessage());

    this._currentRequest = null;
    this._currentParser = null;
    this._currentTarget = null;

    // Let token parsing continue if there's anything left
    return remaining;
};


Client.prototype._parseResponse = function(tokens) {
    // =refNo: normal request response
    if (tokens.length < 2) {
        this._requiredTokens = 2;
        return null;
    }

    if (tokens[1].type !== 'int') {
        return this._protocolError('expected =refNo, got: ' + tokens[1].type);
    }

    var refNo = tokens[1].value;
    tokens = tokens.slice(2);

    var req = this._requests[refNo];
    delete this._requests[refNo];
    if (!req) {
        return this._protocolError('unexpected reply refNo: ' + refNo);
    }

    debug('%s(%s): ok', req.name, refNo);

    this._currentRequest = req;
    this._currentParser = req.rpc.getResponseParser();
    this._currentTarget = req.resolve;

    // Shortcut into parsing the message, which nicely handles the
    // case where an empty response would otherwise not be parsed
    // since there are no more tokens.
    return this._parseMessage(tokens);
};


Client.prototype._parseError = function(tokens) {
    // %refNo: request error response
    if (tokens.length < 2) {
        this._requiredTokens = 2;
        return null;
    }

    if (tokens[1].type !== 'int') {
        return this._protocolError('expected %refNo, got: ' + tokens[1].type);
    }

    var refNo = tokens[1].value;
    tokens = tokens.slice(2);

    var req = this._requests[refNo];
    delete this._requests[refNo];
    if (!req) {
        return this._protocolError('unexpected reply refNo: ' + refNo);
    }

    this._currentRequest = req;
    this._currentParser = req.rpc.getErrorParser();
    this._currentTarget = function(msg) {
        msg.errorName = protocol.errorCodes[msg.errorCode] || ('error-' + msg.errorCode);
        var err = new errors.RequestError(msg);
        debug('%s(%s): %s', req.name, refNo, err);
        req.reject(err);
    };

    // Shortcut
    return this._parseMessage(tokens);
};


var getAsyncTarget = function(client, async) {
    return function(msg) {
        debug('async %s: %j', async.name, msg);
        client.emit(async.name, msg);
    };
};


var getUnknownAsyncParser = function(numParams) {
    // Just consume numParams tokens
    return function(tokens) {
        if (tokens.length < numParams) {
            numParams -= tokens.length;
            return null;
        }
        else {
            return tokens.slice(numParams);
        }
    };
};


Client.prototype._parseAsync = function(tokens) {
    // :numParams msgNum: async message
    if (tokens.length < 3) {
        this._requiredTokens = 3;
        return null;
    }

    if (tokens[1].type !== 'int' || tokens[2].type !== 'int') {
        return this._protocolError('expected :numParams msgNum, got: ' +
                                   tokens[1].type + ' ' + tokens[2].type);
    }

    var numParams = tokens[1].value;
    var msgNum = tokens[2].value;
    tokens = tokens.slice(3);

    var async = protocol.async[msgNum];
    if (async) {
        this._currentParser = async.getMessageParser();
        this._currentTarget = getAsyncTarget(this, async);
    }
    else {
        debug('unknown async: %s (%s params)', msgNum, numParams);
        this._currentParser = getUnknownAsyncParser(numParams);
        this._currentTarget = function() {};
    }

    // Shortcut
    return this._parseMessage(tokens);
};


Client.prototype._protocolError = function(msg) {
    this._onError(new errors.ProtocolError(msg));
};


//
// Populate the client with methods for all requests.
//

var generateMethod = function(name, rpc) {
    Client.prototype[name] = function(params, cb) {
        if (this._state !== 'open') {
            throw new errors.ClientError('cannot send requests in this state: ' + this._state);
        }

        var refNo = this._nextRefNo;
        var msg = rpc.formatRequest(refNo, params);
        this._nextRefNo++;

        if (typeof cb === 'function') {
            this._requests[refNo] = {
                name: name,
                rpc: rpc,
                resolve: function(msg) { cb(null, msg); },
                reject: cb
            };

            // TODO: limit number of requests in flight
            this._socket.write(msg);
        }
        else {
            return new Promise(function(resolve, reject) {
                this._requests[refNo] = {
                    name: name,
                    rpc: rpc,
                    resolve: resolve,
                    reject: reject
                };

                // TODO: limit number of requests in flight
                this._socket.write(msg);
            }.bind(this));
        }
    };
};

for (var n in protocol.rpc) {
    if (protocol.rpc.hasOwnProperty(n)) {
        generateMethod(n, protocol.rpc[n]);
    }
}



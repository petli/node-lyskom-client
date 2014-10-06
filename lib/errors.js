/* LysKOM protocol A client error classes
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var util = require('util');

/** Error parsing the protocol.
 */
var ProtocolError = function(message) {
    this.message = message;
    this.name = "ProtocolError";
    Error.captureStackTrace(this, ProtocolError);
};

util.inherits(ProtocolError, Error);
exports.ProtocolError = ProtocolError;


/** Server-level error.
 */
var ServerError = function(message) {
    this.message = message;
    this.name = "ServerError";
    Error.captureStackTrace(this, ServerError);
};

util.inherits(ServerError, Error);
exports.ServerError = ServerError;


/** Client usage error.
 */
var ClientError = function(message) {
    this.message = message;
    this.name = "ClientError";
    Error.captureStackTrace(this, ClientError);
};

util.inherits(ClientError, Error);
exports.ClientError = ClientError;


/** Request-specific error.
 *
 * Properties:
 *  - errorCode:   numeric error code
 *  - errorName:   protocol name corresponding to the code
 *  - errorStatus: any additional error info (always an integer)
 */
var RequestError = function(info) {
    this.errorCode = info.errorCode;
    this.errorName = info.errorName;
    this.errorStatus = info.errorStatus;
    this.message = info.errorName + ' (' + info.errorStatus + ')';
    this.name = "RequestError";
    Error.captureStackTrace(this, RequestError);
};

util.inherits(RequestError, Error);
exports.RequestError = RequestError;

/* LysKOM protocol A client unit tests
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

// silence errors about "foo.should.be.empty;"
/* jshint -W030 */
/* global describe, it, before, after */

var debug = require('debug')('lyskom-client:test:client'); // jshint ignore:line

var util = require('util');
var events = require('events');
var should = require('should'); // jshint ignore:line

var Client = require('../lib/client');
var errors = require('../lib/errors');


// Dummy Socket, which expect Client to send some data, then respond
// with some other data.  Arguments is a list of
// { expect: string, send: [strings...] }

var ExpectSocket = function() {
    this.expect = Array.prototype.slice.call(arguments);

    this.localAddress = 'foobar';

    setTimeout(function() {
        this.emit('connect');
    }.bind(this), 0);
};

util.inherits(ExpectSocket, events.EventEmitter);

ExpectSocket.prototype.write = function(data) {
    data.should.be.instanceof(Buffer);

    var sent = data.toString('ascii');
    this.expect.length.should.be.greaterThan(0, 'unexpected data: ' + sent);
    var e = this.expect.shift();

    sent.should.equal(e.expect);

    setTimeout(function() {
        for (var i = 0; i < e.send.length; i++) {
            var d = e.send[i];
            if (typeof d === 'string') {
                d = new Buffer(d, 'ascii');
            }
            debug('emitting: %s', d);
            this.emit('data', d);
        }
    }.bind(this), 0);
};

ExpectSocket.prototype.end = function() {
    this.expect.should.have.length(0, 'expected client to send more data: ' + this.expect);

    setTimeout(function() {
        this.emit('end');
        this.emit('close');
    }.bind(this), 0);
};


ExpectSocket.prototype.destroy = function() {
    this.expect = [];
};


describe('Client', function() {
    this.timeout(1000);

    // Ensure controlled handshake string
    var oldUser;

    before(function() {
        oldUser = process.env.USER;
        process.env.USER = 'test';
    });

    after(function() {
        process.env.USER = oldUser;
    });

    it('should connect and do handshake', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] }
        ));

        c.on('connect', function() {
            c.close();
        });

        c.on('close', function() {
            done();
        });
    });

    // TODO: change this to something more interesting than login that actually
    // returns a response
    it('should send login and recieve answer with callback', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] },
            { expect: '0 62 4711 4Htest 0\n',
              send: [ '=0\n' ] }
        ));

        c.on('connect', function() {
            c.login({ person: 4711, passwd: 'test', invisible: false },
                    function(err, msg) {
                        should(err).equal(null);
                        msg.should.be.empty;

                        c.close();
                        done();
                    });
        });
    });

    it('should send login and recieve answer as promise', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] },
            { expect: '0 62 4711 4Htest 0\n',
              send: [ '=0\n' ] }
        ));

        c.on('connect', function() {
            c.login({ person: 4711, passwd: 'test', invisible: false })
                .then(function(msg) {
                    msg.should.be.empty;
                    c.close();
                    done();
                })
                .catch(done);
        });
    });


    it('should send login and recieve error with callback', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] },
            { expect: '0 62 4711 4Htest 0\n',
              send: [ '%', '0 ', '4 10\n' ] }  // test partial parsing too
        ));

        c.on('connect', function() {
            c.login({ person: 4711, passwd: 'test', invisible: false },
                    function(err, msg) {
                        err.errorCode.should.equal(4);
                        err.errorName.should.equal('invalid-password');
                        err.errorStatus.should.equal(10);

                        c.close();
                        done();
                    });
        });
    });

    it('should send login and recieve error as promise', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] },
            { expect: '0 62 4711 4Htest 0\n',
              send: [ '%0 4 ', '10\n' ] }  // test partial parsing too
        ));

        c.on('connect', function() {
            c.login({ person: 4711, passwd: 'test', invisible: false })
                .then(function(msg) {
                    done('should not resolve on error');
                })
                .error(function(err) {
                    err.errorCode.should.equal(4);
                    err.errorName.should.equal('invalid-password');
                    err.errorStatus.should.equal(10);
                    done();
                })
                .catch(done);
        });
    });

    it('should raise protocol error on unexpected token', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] },
            { expect: '0 62 4711 4Htest 0\n',
              send: [ '0 4 0\n' ] }
        ));

        // The error should both reject the request and trigger an event,
        // so wait for both
        var gotErrors = 0;

        c.on('connect', function() {
            c.login({ person: 4711, passwd: 'test', invisible: false })
                .then(function(msg) {
                    done('should not resolve on error');
                })
                .catch(errors.ProtocolError, function(err) {
                    debug('rejected with: %s', err);
                    if (++gotErrors === 2) { done(); }
                })
                .catch(done);
        });

        c.on('error', function(err) {
            debug('got error: %s', err);
            err.should.be.instanceof(errors.ProtocolError);
            if (++gotErrors === 2) { done(); }
        });
    });


    it('should raise protocol error on unexpected parameter type', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n'] },
            { expect: '0 62 4711 4Htest 0\n',
              send: [ '%0 4 3Hfoo\n' ] }
        ));

        // The error should both reject the request and trigger an event,
        // so wait for both
        var gotErrors = 0;

        c.on('connect', function() {
            c.login({ person: 4711, passwd: 'test', invisible: false })
                .then(function(msg) {
                    done('should not resolve on error');
                })
                .catch(errors.ProtocolError, function(err) {
                    debug('rejected with: %s', err);
                    if (++gotErrors === 2) { done(); }
                })
                .catch(done);
        });

        c.on('error', function(err) {
            debug('got error: %s', err);
            err.should.be.instanceof(errors.ProtocolError);
            if (++gotErrors === 2) { done(); }
        });
    });

    it('should parse async send-message', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n',
                     ':', '3 ', '12 4711 1234 6Hfoobar\n'] }
        ));

        c.on('connect', function() {
            c.close();
        });

        c.on('send-message', function(msg) {
            msg.recipient.should.equal(4711);
            msg.sender.should.equal(1234);
            msg.message.toString().should.equal('foobar');
            done();
        });
    });

    it('should parse unknown async message', function(done) {
        var c = new Client(new ExpectSocket(
            { expect: 'A11Htest%foobar\n',
              send: ['LysKOM\n',
                     ':4 9999 4711 ', '1234 6Hfoobar 1\n',
                     // Include parsable message to detect OK parsing
                     ':3 12 4711 1234 6Hfoobar\n'] }
        ));

        c.on('connect', function() {
            c.close();
        });

        c.on('send-message', function(msg) {
            msg.recipient.should.equal(4711);
            msg.sender.should.equal(1234);
            msg.message.toString().should.equal('foobar');
            done();
        });
    });
});

/* LysKOM protocol A: test all requests and messages
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

//
// This runs ONLY against localhost, since you shouldn't run this
// script against any shared LysKOM server (unless you really want to
// annoy people.)
//

var Promise = require('bluebird');

var lyskom = require('../index.js');

var getAsyncHandler = function(name) {
    return function(msg) {
        console.log('<= %s: %j', name, msg);
    };
};

var client;

var timestamp = Date.now();
var persons = [
    { name: 'test ' + timestamp + ' a', },
    { name: 'test ' + timestamp + ' b', },
];
var passwd = 'test';


console.log('Connecting to 127.0.0.1');
lyskom.connectAndWait({host: '127.0.0.1'})
    .then(function(c) {
        client = c;

        client.on('error', function(err) {
            console.error('Connection error: %s', err);
            process.exit(1);
        });

        client.on('close', function() {
            console.error('Connection closed');
            process.exit(0);
        });

        // Listen to all async messages, all the time
        var acceptAsync = [];
        for (var name in lyskom.async) {
            if (lyskom.async.hasOwnProperty(name)) {
                var num = lyskom.async[name];
                if (typeof num === 'number') {
                    acceptAsync.push(num);
                    client.on(name, getAsyncHandler(name));
                }
            }
        }

        console.log('-> acceptAsync: everything');
        return client.acceptAsync({ requestList: acceptAsync });
    })
    .then(function() {
        console.log('-> getVersionInfo');
        return client.getVersionInfo();
    })
    .then(function(info) {
        console.log('<- Protocol version: %s', info.protocolVersion);
        console.log('<- Server software:  %s', info.serverSoftware);
        console.log('<- Software version: %s', info.softwareVersion);

        console.log('-> getTime & getDate');
        return Promise.props({ time: client.getTime(),
                               date: client.getDate() });
    })
    .then(function(v) {
        console.log('<- %s DOW %s DOY %s DST: %s',
                    v.date, v.time.dayOfWeek, v.time.dayOfYear, v.time.isDST);

        console.log('-> createPerson %s', persons[0].name);
        return client.createPerson({
            name: persons[0].name,
            passwd: passwd,
            flags: { unreadIsSecret: true },
            auxItems: [
                { tag: lyskom.aux.emailAddress, flags: {}, inheritLimit: 0, data: 'foo@example.org' },
            ]});
    })
    .then(function(num) {
        console.log('<- %d', num);
        persons[0].number = num;

        console.log('-> login %s', persons[0].number);
        return client.login({ person: persons[0].number, passwd: passwd, invisible: false});
    })
    .then(function() {
        console.log('-> getUconfStat %s', persons[0].number);
        return client.getUconfStat({ conference: persons[0].number });
    })
    .then(function(uconf) {
        console.log('<- %s: %j highest local %s nice %s',
                    uconf.name, uconf.type, uconf.highestLocalNo, uconf.nice);

        console.log('-> logout');
        return client.logout();
    })
    .catch(function(err) {
        console.log('<- Request error: %j', err);
    })
    .then(function() {
        console.log('Closing connection');
        client.close();
    })
    .catch(function(err) {
        console.log('Client error: %j', err);
    });

/* LysKOM protocol A example: chat through messages
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var readline = require('readline');
var iconv = require('iconv-lite');
var Promise = require('bluebird');

var lyskom = require('../index.js');

var argv = require('yargs')
    .usage('$0 --server host --from num_or_name --to num_or_name')
    .demand('server').string('server')
    .demand('from')
    .demand('to')
    .argv;

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('Connecting to %s', argv.server);
lyskom.connectAndWait({host: argv.server})
    .then(function(client) {

        // General event handlers
        client.on('error', function(err) {
            console.error('Error: %s', err);
        });

        client.on('close', function() {
            console.error('Connection closed.');
            process.exit(0);
        });

        // Cache user names, fetching them the first
        // time they are referenced
        var nameCache = {};

        var getName = function(confNo) {
            if (nameCache[confNo]) {
                return nameCache[confNo];
            }

            return client.getUconfStat({conference: confNo})
                .then(function(uconf) {
                    // Don't overwrite if we got the name from a
                    // new-name async in the meantime
                    if (!nameCache[confNo]) {
                        nameCache[confNo] = uconf.name;
                    }
                    return nameCache[confNo];
                });
        };

        // Update cache on name changes
        client.on('new-name', function(msg) {
            console.log('%s changed name to %s', msg.oldName, msg.newName);
            nameCache[msg.confNo] = msg.newName;
        });


        // Determine persNo for a user as number of a string
        var getUniqueUser = function(user) {
            if (typeof user === 'number') {
                return Promise.resolve(user);
            }

            return client.lookupZName({ name: user, wantPersons: true, wantConfs: false })
                .then(function(matches) {
                    switch (matches.length) {
                    case 0:
                        throw new Error('unknown user name: ' + user);

                    case 1:
                        return matches[0].confNo;

                    default:
                        var msg = ['not a unique user name: ' + user, 'Alternatives:'];

                        matches.forEach(function(m) { msg.push(m.name); });

                        throw new Error(msg.join('\n'));
                    }
                });
        };


        // Output received messages

        client.on('send-message', function(msg) {
            Promise.props({
                sender: getName(msg.sender),
                recipient: getName(msg.recipient)
            })
            .then(function(names) {
                console.log('\n%s -> %s:\n%s', names.sender, names.recipient,
                            // messages are generally in latin1
                            iconv.decode(msg.message, 'latin1'));

                // Restart prompt
                rl.prompt();
            });
        });


        // Figure out the user to login as
        getUniqueUser(argv.from)
            .then(function(user) {
                // Ask for password, then log in and ask to recieve async messages
                rl.question('Password (WILL BE ECHOED): ', function(password) {
                    client.login({
                        person: user,
                        passwd: password,
                        invisible: false
                    }).then(
                        function() {
                            console.log('Logged in');

                            return client.acceptAsync({
                                requestList: [lyskom.async.sendMessage, lyskom.async.newName]
                            });
                        }
                    ).then(
                        function() {
                            // Figure out the target
                            return getUniqueUser(argv.to);
                        }
                    ).then(
                        function(target) {

                            // Send messages on input
                            var onReadLine = function(line) {
                                // Conform to sending messages as latin1
                                client.sendMessage({
                                    recipient: target,
                                    message: iconv.encode(line, 'latin1')
                                })
                                    .then(function() {
                                        console.log('Message sent.');
                                        rl.prompt();
                                    })
                                    .error(function(err) {
                                        console.error('Error sending message: %s', err);
                                        rl.prompt();
                                    })
                                    .catch(function(err) {
                                        // If this is critical it will also trigger an error event
                                        console.error('Exception sending message: %s', err);
                                        rl.prompt();
                                    });
                            };

                            // Kick off chat
                            rl.setPrompt('Say: ', 5);
                            rl.on('line', onReadLine);
                            rl.prompt();
                        }
                    ).catch(
                        function(err) {
                            console.error('Error starting chat: %s', err);
                            process.exit(1);
                        }
                    );
                });
            })
            .catch(
                function(err) {
                    console.error('Cannot login: %s', err.message);
                    process.exit(1);
                }
            );
    }).catch(function(err) {
        console.error('Error connecting to server: %s', err);
        process.exit(1);
    });



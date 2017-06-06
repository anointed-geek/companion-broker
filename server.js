const Express = require('express');
const ExpressWS = require("express-ws");
const HTTP = require("http");
const BodyParser = require('body-parser');
const Guid = require("guid");
const _ = require("lodash");
const DataSource = require("./db");
const ServerPort = process.env.PORT || process.env.OPENSHIFT_NODEJS_PORT || 8080;


var Db = new DataSource.Db();
var app = Express();
var expressWS = ExpressWS(app);
var sessions = {};
var sessionTimeout = -1;

app.use(BodyParser.urlencoded({ extended: true }))
app.use(BodyParser.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    next();
});

function createRandomString() {
	var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZ";
	var length = 8;
	var randomString = '';
	for (var i = 0; i < length; i++) {
		var rnum = Math.floor(Math.random() * chars.length);
		randomString += chars.substring(rnum, rnum + 1);
	}

	return randomString;
}

function startSessionHeartbeat() {
	if(sessionTimeout === -1) {
		sessionTimeout = setInterval(()=>{
			console.log("heartbeat");
		}, 5000);
	}
}

function notifyDevice(mapping, message_data) {
	var device = mapping.target;
	var device_ws;
	if(device && device.connected && (device_ws = sessions[device.deviceId])) {
		device_ws.web_socket.send(JSON.stringify(message_data));
	}
}

function notifyCompanion(mapping, id, message_data) {
	var companion = mapping.companions[id];
	var companion_ws;
	if(companion && companion.connected && (companion_ws = sessions[id])) {
		companion_ws.web_socket.send(JSON.stringify(message_data));
	}
}

function notifyCompanions(mapping, message_data) {
	// Message to companions
	for(var key in mapping.companions) {
		notifyCompanion(mapping, key, message_data);
	}
}

function register(deviceId, token, key) {
	Db.connect((mongo, err) => {
		var col = mongo.collection("registrations");
		col.insert({
			token: token,
			key: key,
			target: {deviceId: deviceId, connected: false, registration: new Date()},
			companions: {}
		});
	});
}

function getDevicePairing(token, callback) {
	Db.connect((mongo, err) => {
		var col = mongo.collection("deviceMap");

		col.find({token: token}).toArray((err, results) => {
			callback&&callback(results[0] || null, col || null);
		});
	});
}

function createDevicePairing(token, deviceId, callback) {
	getDevicePairing(token, (pair, col1) => {
		if(pair) {
			// Update and Save
			pair.companions[deviceId] = { deviceId: deviceId, connected: false, registration: new Date() };
			col1.update({}, pair, {upsert: true});
			callback&&callback(pair);
			return;
		}

		findRegistrationByToken(token, (reg, col2) => {
			if(!reg) {
				callback&&callback(null);
				return;
			}

			Db.connect((mongo, err) => {
				var col = mongo.collection("deviceMap"),
					deviceEntry = _.cloneDeep(reg);
				
				// remove from regs
				col2.remove(reg);

				// Add to real list
				delete deviceEntry._id;
				delete deviceEntry.key;
				deviceEntry.companions[deviceId] = { deviceId: deviceId, connected: false, registration: new Date() };
				col.insert(deviceEntry);
				callback&&callback(deviceEntry);
			});
		});
	});
}

function findRegistrationByToken(token, callback) {
	Db.connect((mongo, err) => {
		var col = mongo.collection("registrations");

		col.find({token: token}).toArray((err, results) => {
			callback&&callback(results[0], col);
		});
	});
}

function findRegistrationByKey(key, callback) {
	Db.connect((mongo, err) => {
		var col = mongo.collection("registrations");

		col.find({key: key}).toArray((err, results) => {
			callback&&callback(results[0], col);
		});
	});
}

// 
app.get('/', function(req,res) {
	res.json({greeting: "Hello Server World"});
});

app.post('/register', function (req,res) {
	var deviceId = req.body.deviceId;
	var possibleToken = req.body.token;
	var newGuid = Guid.create().value;
	var newKey = createRandomString();

	// check if in device mapping
	getDevicePairing(possibleToken, (pair, col1) => {
		if(pair) {
			register(deviceId, pair.token, newKey);
			res.json({ token: pair.token, key: newKey });
			return;
		}

		// No device, check registrations
		findRegistrationByToken(possibleToken, (reg, col2) => {
			if(reg) {
				reg.key = newKey;
				col2.remove(reg);
				delete reg._id;
				col2.insert(reg);
				res.json({ token: reg.token, key: newKey });
				return;
			}

			// No registration, register now
			register(deviceId, newGuid, newKey);
			res.json({ token: newGuid, key: newKey });
		});
	});
});

app.post('/pair-device', function (req,res) {
	var deviceId = req.body.deviceId;
	var key = req.body.key;

	findRegistrationByKey(key, (reg, col1) => {
		if(reg) {
			createDevicePairing(reg.token, deviceId, ()=>{
				res.json({ token: reg.token, message: { status: "SUCCESS"} });
			});

		} else {
			res.json({ message: {status: "PAIRING FAILED"} });
		}
	});
});

app.get("/device-list/:sessionToken/device/:deviceId", function (req,res) {
	var token = req.params.sessionToken;
	var deviceId = req.params.deviceId;
	var additionalData = {};

	getDevicePairing(token, (pairing, col1) => {
		if(!pairing) {
			findRegistrationByToken(token, (reg, col2) => {
				if(!reg) {
					res.sendStatus(401);
					return;
				}

				res.json({ token: token, message: { status: "REGISTERED_PAIRING", companions: [] } });
			});
			return;
		}

		// Send list of devices
		if(pairing.target.deviceId === deviceId) {
			additionalData = { status: "REGISTERED_PAIRING_COMPLETE", companions: pairing.companions };
		}
		
		res.json({ token: token, message: additionalData });
	});
});

//////////////////////////////////////////
/*
interface ICompanionClientRequest {
	command: number,
	token: string,
	data: any
}
*/
/////////////////////////////////////////
app.ws("/remote", function(ws, req) {
	ws.on("close", (wsid) => {
		console.log("closed");

		var session = _.find(sessions, (sess) => { return sess.web_socket == ws; });
		if(session) {
			getDevicePairing(session.token, (pairing, coll) => {
				var isCompanion = session.isCompanion;
				var deviceInfo = !isCompanion ? pairing.target : pairing.companions[session.deviceId];

				// Remove session
				deviceInfo.connected = false;
				delete sessions[session.deviceId];
				coll.update({}, pairing, {upsert: true});

				// Notify connected parties
				if(isCompanion) {
					notifyDevice(pairing, { status: "COMPANION_UPDATE", companions: pairing.companions });
				} else {
					notifyCompanions(pairing, {status: "DEVICE_DISCONNECTED"});
				}
			});
		}
	});

	// Handshake auth
	ws.on("message", (rawMessage) => {
		console.log('received: %s', rawMessage);
		var msg = "";
		try{
			msg = JSON.parse(rawMessage);
		} catch(e){
			ws.send(JSON.stringify({ status: "INVALID_MESSAGE"}));
			ws.close();
			return;
		}
		
		var deviceId = msg.deviceId;
		var token = msg.token;
		//1. Ensure payload is set
		if(!token || !deviceId) {
			ws.close(); 
			return;
		}


		getDevicePairing(token, (pairing, coll1) => {
			// Should never happen
			if(!pairing) {
				ws.send(JSON.stringify({status: "UNAUTHORIZED"}));
				ws.close();
				return;
			}

			var websocket_session = sessions[deviceId] = (sessions[deviceId] || { deviceId: deviceId, isCompanion: (deviceId != pairing.target.deviceId), token: token, web_socket: ws, handshake_complete: false, last_updated: new Date() });
			websocket_session.web_socket = ws;
			
			// Handshake
			if(deviceId === pairing.target.deviceId) {
				if(msg.command === 0) {
					pairing.target.connected = true;
					websocket_session.handshake_complete = true;

					coll1.update({}, pairing, {upsert: true}, ()=>{
						notifyDevice(pairing, { status: "AUTHENTICATED", companions: pairing.companions });
						notifyCompanions(pairing, {status: "DEVICE_CONNECTED"});
					});
					
				} else if(websocket_session.handshake_complete) {

					// Relay message
					notifyCompanions(pairing, msg );
				}

			} else {
				if(msg.command === 0) {
					pairing.companions[deviceId].connected = true;
					websocket_session.handshake_complete = true;

					coll1.update({}, pairing, {upsert: true}, ()=>{
						notifyCompanion(pairing, deviceId, { status: (pairing.target.connected ? "AUTHENTICATED_CONNECTED" : "AUTHENTICATED") });
						notifyDevice(pairing, { status: "COMPANION_UPDATE", companions: pairing.companions });

						// Notify target 
						startSessionHeartbeat();
					});
					
				} else if(websocket_session.handshake_complete) {
					// Relay message
					notifyDevice(pairing, msg );
				}
			}
			
			// If did not handshake, disconnect
			if(!websocket_session.handshake_complete) {
				ws.close();
			}
		});
	});
});

app.listen(ServerPort, () => {
	Db.connect((mongo, err) => {
		console.log("Express server running on port", ServerPort);
	});
});

module.exports = app;
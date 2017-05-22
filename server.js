const Express = require('express');
const ExpressWS = require("express-ws");
const HTTP = require("http");
const BodyParser = require('body-parser');
const Guid = require("guid");
const _ = require("lodash");
const ServerPort = process.argv[2] || 8080;

var app = Express();
var expressWS = ExpressWS(app);
var deviceMap = {};
var registrations = {};
var sessions = {};
var sessionTimeout = -1;

app.use(BodyParser.urlencoded({ extended: true }))
app.use(BodyParser.json());

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

function getDevicePairing(token) {
	return deviceMap[token];
}

function createDevicePairing(token) {
	return deviceMap[token] = deviceMap[token] || {};
}

// 
app.get('/', function(req,res) {
	res.json({greeting: "Hello Server World"});
});

app.post('/companion/register', function (req,res) {
	var deviceId = req.body.deviceId;
	var token = (getDevicePairing(req.body.token) && req.body.token) || Guid.create();
	var key = createRandomString();

	registrations[key] = {
		token: token,
		target: {deviceId: deviceId, connected: false, registration: new Date()},
		companions: {}
	};

	res.json({ token: token, key: key });
});

app.post('/companion/pair-device', function (req,res) {
	var deviceId = req.body.deviceId;
	var key = req.body.key;
	var pending = registrations[key];
	var pairing;
	
	if (pending) {
		delete registrations[key];
		
		// Save
		if(!(pairing = getDevicePairing(pending.token))) {
			pairing = createDevicePairing(pending.token);
		} 
		
		pairing.companions[deviceId] = {connected: false, registration: new Date()};		

		// Valid, return the acknowledgement
		res.json({ token: pending.token, message: { status: "SUCCESS"} });
		
	} else {
		// invalid
		res.json({ message: {status: "FAILURE"} });
	}
});

app.get("/companion/:sessionToken/device/:deviceId", function (req,res) {
	var token = req.params.sessionToken;
	var deviceId = req.params.deviceId;
	var pairing = getDevicePairing(token);
	var additionalData = {};
	if (pairing) {
		
		// Send list of devices
		if(pairing.target.deviceId === deviceId) {
			additionalData = { companions: pairing.companions };
		}
		
		res.json({ token: token, data: additionalData });
		
	} else {
		res.sendStatus(401);
	}
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
app.ws("/companion/remote", function(ws, req) {
	ws.on("close", (wsid) => {
		console.log("closed");

		for(var deviceId in sessions) {
			var web_socket_session;
			if(web_socket_session = sessions[deviceId]) {
				if(web_socket_session.web_socket === ws) {
					var pairing = getDevicePairing(web_socket_session.token);
					var isCompanion = (pairing.target.deviceId != deviceId);
					var deviceInfo = !isCompanion ? pairing.target : pairing.companions[deviceId];

					// Remove session
					deviceInfo.connected = false;
					delete sessions[deviceId];

					// Notify connected parties
					if(isCompanion) {
						notifyDevice(pairing, { status: "COMPANION_UPDATE", companions: pairing.companions });
					} else {
						notifyCompanions(pairing, {status: "DEVICE_DISCONNECTED"});
					}
				}
			}
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
		var pairing = getDevicePairing(token);
		
		//1. Ensure payload is set
		if(!pairing || !token || !deviceId) {
			ws.close(); 
			return;
		}
		
		var websocket_session = sessions[deviceId] = (sessions[deviceId] || { token: token, web_socket: ws, handshake_complete: false, last_updated: new Date() });
		websocket_session.web_socket = ws;
		
		// Handshake
		if(deviceId === pairing.target.deviceId) {
			if(msg.command === 0) {
				pairing.target.connected = true;
				websocket_session.handshake_complete = true;

				notifyDevice(pairing, { status: "AUTHENTICATED", companions: pairing.companions });
				notifyCompanions(pairing, {status: "DEVICE_CONNECTED"});
				
			} else if(websocket_session.handshake_complete) {

				// Relay message
				notifyCompanions(pairing, msg );
			}

		} else {
			if(msg.command === 0) {
				pairing.companions[deviceId].connected = true;
				websocket_session.handshake_complete = true;

				notifyCompanion(pairing, deviceId, { status: "AUTHENTICATED" });
				notifyDevice(pairing, { status: "COMPANION_UPDATE", companions: pairing.companions });
				
				// Notify target 
				startSessionHeartbeat();
				
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

app.listen(ServerPort, () => {
	console.log("Express server running on port", ServerPort);
});
Base Url: http://companion-broker-companion-broker.1d35.starter-us-east-1.openshiftapps.com/

GET /
==============
Test JSON

POST /register
================
Registers the device for companion setup, returns a generated key for auth confirmation
body JSON: { deviceId: "YOUR_DEVICE_ID_HERE" }

POST /pair-device
================
Registers the companion to a pending registration
body JSON: { deviceId: "YOUR_DEVICE_ID_HERE", key: "GENERATED_KEY_HERE" }

GET /device-list/:sessionToken/device/:deviceId
================
Lists the device connected companions
body JSON: { deviceId: "YOUR_DEVICE_ID_HERE" }

WEBSOCKET /remote
================
body JSON: { deviceId: "YOUR_DEVICE_ID_HERE", token: "TOKEN", command: NUMBER }




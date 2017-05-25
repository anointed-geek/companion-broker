var mongodb = require('mongodb');
var fs = require('fs');

module.exports = {
    Db: function() {
        this.mDBConn = null;

        this.getDbConnString = function() {
            var mongoURL = process.env.OPENSHIFT_MONGODB_DB_URL || process.env.MONGO_URL;
            if (!mongoURL && process.env.DATABASE_SERVICE_NAME) {
                var mongoServiceName = process.env.DATABASE_SERVICE_NAME.toUpperCase(),
                    mongoHost = process.env[mongoServiceName + '_SERVICE_HOST'],
                    mongoPort = process.env[mongoServiceName + '_SERVICE_PORT'],
                    mongoDatabase = process.env[mongoServiceName + '_DATABASE'],
                    mongoPassword = process.env[mongoServiceName + '_PASSWORD']
                    mongoUser = process.env[mongoServiceName + '_USER'];

                if (mongoHost && mongoPort && mongoDatabase) {
                    mongoURL = 'mongodb://';
                    if (mongoUser && mongoPassword) {
                        mongoURL += mongoUser + ':' + mongoPassword + '@';
                    }
                    // Provide UI label that excludes user id and pw
                    mongoURL += mongoHost + ':' +  mongoPort + '/' + mongoDatabase;
                }
            }

            return mongoURL || JSON.parse(fs.readFileSync("package.json", "utf8")).db["conn-str"];
        }

        this.connect = function(callback) {
            
            if(!this.mDBConn) {
                var connUrl = this.getDbConnString();
                console.log("Connecting to MongoDB at: %s", connUrl);
                mongodb.connect(connUrl, (err, conn) => {
                    if(err) {
                        console.log('Error trying to connect to MongoDB at: %s', JSON.stringify(err));
                    } else {
                        console.log('Connected to MongoDB!');
                    }
                    
                    callback&&callback((this.mDBConn = conn), err);
                });


            } else {
                // Already open
                callback&&callback(this.mDBConn, null);
            }
            
        }
    }
}
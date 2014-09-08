var async = require('async');
var assert = require('assert');
var util = require('util');
var types = require('../lib/types.js');
var utils = require('../lib/utils.js');

var helper = {
  /**
   * Execute the query per each parameter array into paramsArray
   * @param {Connection|Client} con
   * @param {String} query
   * @param {Array} paramsArray Array of arrays of params
   * @param {Function} callback
   */
  batchInsert: function (con, query, paramsArray, callback) {
    async.mapSeries(paramsArray, function (params, next) {
      con.execute(query, params, {consistency: types.consistencies.one}, next);
    }, callback);
  },
  throwop: function (err) {
    if (err) throw err;
  },
  /**
   * @type {ClientOptions}
   */
  baseOptions: (function () {
    var loadBalancing = require('../lib/policies/load-balancing.js');
    var reconnection = require('../lib/policies/reconnection.js');
    var retry = require('../lib/policies/retry.js');
    return {
      policies: {
        loadBalancing: new loadBalancing.RoundRobinPolicy(),
        reconnection: new reconnection.ExponentialReconnectionPolicy(1000, 10 * 60 * 1000, false),
        retry: new retry.RetryPolicy()
      },
      contactPoints: ['127.0.0.1']
    };
  })(),
  /**
   * Returns a pseudo-random name in the form of 'ab{n}', n being an int zero padded with string length 16
   * @returns {string}
   */
  getRandomName: function (prefix) {
    if (!prefix) {
      prefix = 'ab';
    }
    var value = Math.floor(Math.random() * utils.maxInt);
    return prefix + ('000000000000000' + value.toString()).slice(-16);
  },
  ipPrefix: '127.0.0.',
  Ccm: Ccm,
  ccmHelper: {
    /**
     * @returns {Function}
     */
    start: function (nodeLength) {
      return (function (done) {
        new Ccm().startAll(nodeLength, function (err) {
          done(err);
        });
      });
    },
    remove: function (callback) {
      new Ccm().remove(callback);
    },
    /**
     * Adds a new node to the cluster
     * @param {Number} nodeIndex 1 based index of the node
     * @param {Function} callback
     */
    bootstrapNode: function (nodeIndex, callback) {
      var ipPrefix = helper.ipPrefix;
      new Ccm().exec([
        'add',
        'node' + nodeIndex,
        '-i',
        ipPrefix + nodeIndex,
        '-j',
        (7000 + 100 * nodeIndex).toString(),
        '-b'
      ], callback);
    },
    /**
     * @param {Number} nodeIndex 1 based index of the node
     * @param {Function} callback
     */
    startNode: function (nodeIndex, callback) {
      new Ccm().exec(['node' + nodeIndex, 'start'], callback);
    },
    exec: function (params, callback) {
      new Ccm().exec(params, callback);
    }
  },
  /**
   * Creates a table containing all common types
   * @param {String} tableName
   */
  createTableCql: function (tableName) {
    return  util.format(' CREATE TABLE %s (' +
      '   id uuid primary key,' +
      '   ascii_sample ascii,' +
      '   text_sample text,' +
      '   int_sample int,' +
      '   bigint_sample bigint,' +
      '   float_sample float,' +
      '   double_sample double,' +
      '   decimal_sample decimal,' +
      '   blob_sample blob,' +
      '   boolean_sample boolean,' +
      '   timestamp_sample timestamp,' +
      '   inet_sample inet,' +
      '   timeuuid_sample timeuuid,' +
      '   map_sample map<text, text>,' +
      '   list_sample list<text>,' +
      '   list_sample2 list<int>,' +
      '   set_sample set<text>)', tableName);
  },
  createKeyspaceCql: function (keyspace, replicationFactor) {
    return util.format('CREATE KEYSPACE %s WITH replication = {\'class\': \'SimpleStrategy\', \'replication_factor\' : %d};',
      keyspace,
      replicationFactor);
  },
  assertValueEqual: function (val1, val2) {
    if (val1 === null && val2 === null) {
      return;
    }
    if (val1 instanceof Buffer && val2 instanceof Buffer) {
      val1 = val1.toString('hex');
      val2 = val2.toString('hex');
    }
    if (val1 instanceof types.Long && val2 instanceof types.Long ||
      val1 instanceof Date && val2 instanceof Date) {
      val1 = val1.toString();
      val2 = val2.toString();
    }
    if (util.isArray(val1) || (val1.constructor && val1.constructor.name === 'Object')) {
      val1 = util.inspect(val1, {depth: null});
      val2 = util.inspect(val2, {depth: null});
    }
    assert.strictEqual(val1, val2);
  },
  assertInstanceOf: function (instance, constructor) {
    assert.notEqual(instance, null, 'Expected instance, obtained ' + instance);
    assert.ok(instance instanceof constructor, 'Expected instance of ' + constructor.name + ', actual constructor: ' + instance.constructor.name);
  },
  /**
   * Returns a function that waits on schema agreement before executing callback
   * @param {Client} client
   * @param {Function} callback
   * @returns {Function}
   */
  waitSchema: function (client, callback) {
    return (function (err) {
      if (err) return callback(err);
      if (!client.hosts) {
        throw new Error('No hosts on Client')
      }
      if (client.hosts.length === 1) {
        return callback();
      }
      setTimeout(callback, 200 * client.hosts.length);
    });
  }
};

function Ccm() {
  //Use an instance to maintain state
}

/**
 * Removes previous and creates a new cluster (create, populate and start)
 * @param {Number|String} nodeLength number of nodes in the cluster. If multiple dcs, use the notation x:y:z:...
 * @param {Function} callback
 */
Ccm.prototype.startAll = function (nodeLength, callback) {
  var self = this;
  async.series([
    function (next) {
      //it wont hurt to remove
      self.exec(['remove'], function () {
        //ignore error
        next();
      });
    },
    function (next) {
      self.exec(['create', 'test', '-v', '2.0.8'], next);
    },
    function (next) {
      self.exec(['populate', '-n', nodeLength.toString()], next);
    },
    function (next) {
      self.exec(['start'], next);
    },
    self.waitForUp.bind(self)
  ], function (err) {
    callback(err);
  });
};

Ccm.prototype.exec = function (params, callback) {
  if (!callback) {
    callback = function () {};
  }
  var spawn = require('child_process').spawn;
  var process = spawn('ccm', params);
  var stdoutArray= [];
  var stderrArray= [];
  var closing = 0;
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', function (data) {
    stdoutArray.push(data);
  });

  process.stderr.on('data', function (data) {
    stderrArray.push(data);
  });

  process.on('close', function (code) {
    if (closing++ > 0) {
      //avoid calling multiple times
      return;
    }
    var info = {code: code, stdout: stdoutArray, stderr: stderrArray};
    var err = null;
    if (code !== 0) {
      err = new Error(
          'Error executing ccm\n' +
          info.stderr.join('\n') +
          info.stdout.join('\n')
      );
      err.info = info;
    }
    callback(err, info);
  });
};

Ccm.prototype.remove = function (callback) {
  this.exec(['remove'], callback);
};

/**
 * Reads the logs to see if the cql protocol is up
 * @param callback
 */
Ccm.prototype.waitForUp = function (callback) {
  var started = false;
  var retryCount = 0;
  var self = this;
  async.whilst(function () {
    return !started && retryCount < 10;
  }, function iterator (next) {
    self.exec(['node1', 'showlog'], function (err, info) {
      if (err) return next(err);
      var regex = /Starting listening for CQL clients/mi;
      started = regex.test(info.stdout.join(''));
      retryCount++;
      if (!started) {
        //wait 1 sec between retries
        return setTimeout(next, 1000);
      }
      return next();
    });
  }, callback);
};


module.exports = helper;
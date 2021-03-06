/******************************************************************************
Copyright (c) 2012, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of Google, Inc. nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
******************************************************************************/

var events = require('events');
var fs = require('fs');
var http = require('http');
var logger = require('logger');
var multipart = require('multipart');
var path = require('path');
var url = require('url');
var util = require('util');
var Zip = require('node-zip');

/** Allow tests to stub out . */
exports.process = process;

var GET_WORK_SERVLET = 'work/getwork.php';
var RESULT_IMAGE_SERVLET = 'work/resultimage.php';
var WORK_DONE_SERVLET = 'work/workdone.php';

// Task JSON field names
var JOB_FIRST_VIEW_ONLY = 'fvonly';
var JOB_REPLAY = 'replay';
var JOB_RUNS = 'runs';
var JOB_TEST_ID = 'Test ID';

var DEFAULT_JOB_TIMEOUT = 900000;
/** Allow test access. */
exports.JOB_FINISH_TIMEOUT = 30000;
/** Allow test access. */
exports.NO_JOB_PAUSE = 10000;
var MAX_RUNS = 1000;  // Sanity limit

// Signal names, in increasing order
var SIGQUIT = 'SIGQUIT';
var SIGABRT = 'SIGABRT';
var SIGTERM = 'SIGTERM';
var SIGINT = 'SIGINT';
var SIGNAL_NAMES = [SIGQUIT, SIGABRT, SIGTERM, SIGINT];


/**
 * A job to run, usually received from the server.
 *
 * Public attributes:
 *   task JSON descriptor received from the server for this job.
 *   id the job id
 *   runs the total number of repetitions for the job.
 *   runNumber the current iteration number.
 *       Incremented when calling runFinished with isRunFinished=true.
 *   isFirstViewOnly if true, each run is in a clean browser session.
 *       if false, a run includes two iterations: clean + repeat with cache.
 *   isCacheWarm false for first load of a page, true for repeat load(s).
 *       False by default, to be set by callbacks e.g. Client.onStartJobRun.
 *       Watch out for old values, always set on each run.
 *   resultFiles array of ResultFile objects.
 *   zipResultFiles map of filenames to Buffer objects, to send as result.zip.
 *   error an error object if the job failed.
 *
 *   NEW: eventName eventName set by setEventName script command
 *
 * The constructor does some input validation and throws an Error, but it
 * would not report the error back to the WPT server, because Client.currentJob_
 * is not yet set -- the error would only get logged.
 *
 * @this {Job}
 * @param {Object} client should submit this job's results when done.
 * @param {Object} task holds information about the task such as the script
 *                 and browser.
 */
function Job(client, task) {
  'use strict';
  this.client_ = client;
  this.task = task;
  this.id = task[JOB_TEST_ID];
  if ('string' !== typeof this.id || !this.id) {
    throw new Error('Task has invalid/missing id: ' + JSON.stringify(task));
  }
  var runs = task[JOB_RUNS];
  if ('number' !== typeof runs || runs <= 0 || runs > MAX_RUNS ||
      0 !== (runs - Math.floor(runs))) {  // Make sure it's an integer.
    throw new Error('Task has invalid/missing number of runs: ' +
        JSON.stringify(task));
  }
  this.runs = runs;
  this.isFirstViewOnly = jsonBoolean(task, JOB_FIRST_VIEW_ONLY);
  this.isReplay = jsonBoolean(task, JOB_REPLAY);
  this.runNumber = this.isReplay ? 0 : 1;
  this.isCacheWarm = false;
  this.resultFiles = [];
  this.zipResultFiles = {};
  this.error = undefined;
  this.eventName = undefined;
}
/** Public class. */
exports.Job = Job;

function jsonBoolean(task, attr) {
  'use strict';
  var value = task[attr];
  if (value === undefined) {
    return false;
  } else if (0 === value || 1 === value) {
    return !!value;
  }
  throw new Error('Invalid task field "' + attr + '": ' + JSON.stringify(task));
}

/**
 * Called to finish the current run of this job, submit results, start next run.
 *
 * @param {boolean} isRunFinished true if finished.
 */
Job.prototype.runFinished = function(isRunFinished) {
  'use strict';
  this.client_.finishRun_(this, isRunFinished);
};

/**
 * ResultFile sets information about the file produced as a
 * result of running a job.
 *
 * @this {ResultFile}
 *
 * @param {string=} resultType a ResultType constant defining the file role.
 * @param {string} fileName file will be sent to the server with this filename.
 * @param {string} contentType MIME content type.
 * @param {string|Buffer} content the content to send.
 */
function ResultFile(resultType, fileName, contentType, content) {
  'use strict';
  this.resultType = resultType;
  this.fileName = fileName;
  this.contentType = contentType;
  this.content = content;
}
/** Public class. */
exports.ResultFile = ResultFile;

/**
 * Constants to use for ResultFile.resultType.
 */
ResultFile.ResultType = Object.freeze({
  IMAGE: 'image',
  IMAGE_ANNOTATIONS: 'image_annotations',
  PCAP: 'pcap'
});


/**
 * processResponse will take a http GET response, concat its data until it
 * finishes and pass it to callback
 *
 * @param {Object} response http GET response object.
 * @param {Function=} callback Function({Error=} err, {string=} HTTP response
 *     body).
 */
exports.processResponse = function(response, callback) {
  'use strict';
  var responseBody = '';
  response.setEncoding('utf8');
  response.on('data', function(chunk) {
    responseBody += chunk;
  });
  response.on('error', function(e) {
    logger.error('Unable to processResponse ' + e.stack);
    if (callback) {
      callback(e, responseBody);
    }
  });
  response.on('end', function() {
    logger.extra('Got response: %s', responseBody);
    if (callback) {
      callback(undefined, responseBody);
    }
  });
};

/**
 * A WebPageTest client that talks to the WebPageTest server.
 *
 * @this {Client}
 * #field {Function=} onStartJobRun called upon a new job run start.
 *     #param {Job} job the job whose run has started.
 *         MUST call job.runFinished() when done, even after an error.
 * #field {Function=} onAbortJob job timeout callback.
 *     #param {Job} job the job that timed out.
 *         MUST call job.runFinished() after handling the timeout.
 * #field {Function=} onIsReady agent ready check callback.
 *     Any exception would skip polling for new jobs.
 *
 * @param {webdriver.promise.ControlFlow} app the ControlFlow for scheduling.
 * @param {Object} args that contains:
 *     #param {string} serverUrl server base URL.
 *     #param {string} location location name to use for job polling
 *        and result submission.
 *     #param {?string=} deviceSerial mobile device id, if any.
 *     #param {?string=} apiKey API key, if any.
 *     #param {number=} jobTimeout milliseconds until the job is killed.
 */
function Client(app, args) {
  'use strict';
  events.EventEmitter.call(this);
  this.app_ = app;
  var serverUrl = (args.serverUrl || '');
  if (-1 === serverUrl.indexOf('://')) {
    serverUrl = 'http://' + serverUrl;
  }
  this.baseUrl_ = url.parse(serverUrl || '');
  // Bring the URL path into a normalized form ending with /
  // The trailing / is for url.resolve not to strip the last path component
  var urlPath = this.baseUrl_.path;
  if (urlPath && urlPath.slice(urlPath.length - 1) !== '/') {
    urlPath += '/';
  }
  if (!urlPath) {
    throw new Error('Invalid serverUrl: ' + args.serverUrl);
  }
  this.baseUrl_.path = urlPath;
  this.baseUrl_.pathname = urlPath;
  this.location_ = args.location;
  this.deviceSerial_ = args.deviceSerial;
  this.name_ = args.name;
  this.apiKey_ = args.apiKey;
  this.noJobTimer_ = undefined;
  this.timeoutTimer_ = undefined;
  this.currentJob_ = undefined;
  this.jobTimeout = args.jobTimeout || DEFAULT_JOB_TIMEOUT;
  this.onStartJobRun = undefined;
  this.onAbortJob = undefined;
  this.onIsReady = undefined;
  this.handlingUncaughtException_ = undefined;
  this.handlingSignal_ = undefined;

  exports.process.on('uncaughtException', this.onUncaughtException_.bind(this));
  SIGNAL_NAMES.forEach(function(signal_name) {
    exports.process.on(signal_name, this.onSignal_.bind(this, signal_name));
  }.bind(this));

  logger.extra('Created Client (urlPath=%s): %j', urlPath, this);
}
util.inherits(Client, events.EventEmitter);
/** Allow test access. */
exports.Client = Client;

/**
 * Handles process signals.
 *
 * @param {string} signal_name signal name:
 *    'SIGQUIT' (kill -3):     Exit after finishing job (clean).
 *    'SIGABRT' (kill -6):     Exit after finishing run (abort job).
 *    'SIGTERM' (kill [-15]):  Exit after aborting run (aborts job).
 *    'SIGINT'  (kill -2, ^C): Same as SIGTERM except nodejs kills our child.
 * @private
 */
Client.prototype.onSignal_ = function(signal_name) {
  'use strict';
  // Set our signal to the max(new_signal, old_signal)
  var old_signal = this.handlingSignal_;
  var new_signal = SIGNAL_NAMES[Math.max(
      SIGNAL_NAMES.indexOf(signal_name), SIGNAL_NAMES.indexOf(old_signal))];
  this.handlingSignal_ = new_signal;

  if (this.noJobTimer_) {
    // Exit now.  We check the noJobTimer_ instead of !currentJob_ because
    // (a) noJobTimer_ implies !currentJob_ and, more importantly,
    // (b)  we don't want to exit in the middle of requesting a new job.
    logger.alert('Received %s, exiting.', signal_name);
    exports.process.exit();
  } else {
    // Exit later, when we're 'done' or get a 'nojob' event.
    if (!old_signal) {
      this.removeAllListeners();
      ['done', 'nojob'].forEach(function(event_name) {
        this.on(event_name, function() {
          logger.alert('Exiting due to %s.', this.handlingSignal_);
          exports.process.exit();
        }.bind(this));
      }.bind(this));
    }
    logger.alert('Received %s, will exit after the current %s.', signal_name,
        (SIGQUIT === new_signal ? 'job finishes' :
         SIGABRT === new_signal ? 'run finishes' :
         SIGTERM === new_signal ? 'run aborts' : 'run is killed'));
    var job = this.currentJob_;
    if (job &&
         (SIGTERM === new_signal || SIGINT === new_signal) &&
         (SIGTERM !== old_signal && SIGINT !== old_signal)) {
      job.error = this.handlingSignal_;
      this.abortJob_(job);
    }
  }
};

/**
 * Unhandled exception in the client process.
 *
 * @param {Error} e error object.
 * @private
 */
Client.prototype.onUncaughtException_ = function(e) {
  'use strict';
  logger.critical('Unhandled exception in the client: %s\n%s', e, e.stack);
  logger.debug('%s', e.stack);
  if (this.handlingUncaughtException_) {
    logger.critical(
        'Unhandled exception while handling another unhandled exception: %s',
        this.handlingUncaughtException_.message);
    // Stop handling an uncaught exception altogether
    this.handlingUncaughtException_ = undefined;
    // ...and we cannot do anything else, and we might stop working.
    // We could try to force-restart polling for jobs, not sure.
  } else if (this.currentJob_) {
    logger.critical('Unhandled exception while processing job %s',
        this.currentJob_.id);
    // Prevent an infinite loop for an exception while submitting job results.
    this.handlingUncaughtException_ = e;
    this.currentJob_.error = e.message;
    this.currentJob_.runFinished(/*isRunFinished=*/true);
  } else {
    logger.critical('Unhandled exception outside of job processing');
    // Not sure if we can do anything, maybe force-restart polling for jobs.
  }
};

/**
 * requestNextJob_ will query the server for a new job and will either process
 * the job response to begin it, emit 'nojob' or 'shutdown'.
 *
 * @private
 */
Client.prototype.requestNextJob_ = function() {
  'use strict';
  this.app_.schedule('Check if agent is ready for new jobs', function() {
    if (this.onIsReady) {
      this.onIsReady();
    }
  }.bind(this)).then(function() {
    var getWorkUrl = url.resolve(this.baseUrl_,
      GET_WORK_SERVLET +
        '?location=' + encodeURIComponent(this.location_) +
        (this.name_ ?
          ('&pc=' + encodeURIComponent(this.name_)) : (this.deviceSerial_ ?
          ('&pc=' + encodeURIComponent(this.deviceSerial_)) : '')) +
        (this.apiKey_ ? ('&key=' + encodeURIComponent(this.apiKey_)) : '') +
        '&f=json');

    logger.info('Get work: %s', getWorkUrl);
    var request = http.get(url.parse(getWorkUrl), function(res) {
      exports.processResponse(res, function(e, responseBody) {
        if (e || responseBody === '') {
          this.emit('nojob');
        } else if (responseBody[0] === '<') {
          // '<' is a sign that it's HTML, most likely an error page.
          logger.warn('Error response? ' + responseBody);
          this.emit('nojob');
        } else if (responseBody === 'shutdown') {
          // We could simply process.exit() here
          this.emit('shutdown');
        } else {  // We got a job
          this.processJobResponse_(responseBody);
        }
      }.bind(this));
    }.bind(this));
    request.on('error', function(e) {
      logger.warn('Got error: ' + e.message);
      this.emit('nojob');
    }.bind(this));
  }.bind(this), function(e) {
    logger.warn('Agent is not ready: ' + e.message);
    this.emit('nojob');
  }.bind(this));
};

/**
 * processJobResponse_ processes a server response and starts a new job
 *
 * @private
 *
 * @param {string} responseBody server response as stringified JSON
 *                 with job information.
 */
Client.prototype.processJobResponse_ = function(responseBody) {
  'use strict';
  // Catch parse exceptions here, since our onUncaughtException_ handler lacks
  // a currentJob_.  We can't report this error back to the WPT server, since
  // we're unable to parse the Task ID, so we'll simply ignore it.
  var task;
  try {
    task = JSON.parse(responseBody);
  } catch (e) {
    logger.warn('Ignoring job with invalid JSON: "%s"', responseBody);
    this.emit('nojob');
    return;
  }
  // TODO(klm): remove if/when WPT server starts sending explicit replay=1.
  // Detect WebPageReplay request mangled into the browser name.
  if (task.browser && /-wpr$/.test(task.browser)) {
    task.browser = task.browser.match(/(.*)-wpr$/)[1];
    task[JOB_REPLAY] = 1;
  }
  var job = new Job(this, task);
  if (SIGTERM === this.handlingSignal_ || SIGINT === this.handlingSignal_) {
    // Got a signal in the middle of a job request, abort the job immediately.
    job.error = this.handlingSignal_;
    this.abortJob_(job);
  }
  this.currentJob_ = null;
  logger.info('Got job: %s', JSON.stringify(job, function(name, value) {
    // ControlFlow has circular references to us through its queue.
    return ('app_' === name) ? '<REDACTED>' : value;
  }));
  this.startNextRun_(job);
};

/**
 * @param {Job} job the job to start/continue.
 * @private
 */
Client.prototype.abortJob_ = function(job) {
  'use strict';
  logger.error('Aborting job %s: %s', job.id, job.error);
  if (this.onAbortJob) {
    this.onAbortJob(job);
  } else {
    job.runFinished(/*isRunFinished=*/true);
  }
};

/**
 * @param {Job} job the job to start/continue.
 * @private
 */
Client.prototype.startNextRun_ = function(job) {
  'use strict';
  job.error = undefined;  // Reset previous run's error, if any.
  // For comparison in finishRun_()
  this.currentJob_ = job;
  // Set up job timeout
  this.timeoutTimer_ = global.setTimeout(function() {
    job.error = 'timeout';
    this.abortJob_(job);
  }.bind(this), this.jobTimeout + exports.JOB_FINISH_TIMEOUT);

  if (this.onStartJobRun) {
    try {
      this.onStartJobRun(job);
    } catch (e) {
      logger.debug('onStartJobRunFailed: %s\n%s', e.stack);
      job.error = e.message;
      this.abortJob_(job);
    }
  } else {
    job.error = 'Client.onStartJobRun not set';
    this.abortJob_(job);
  }
};

/**
 * Ensures that the supposed job finished is actually the current one.
 * If it is, it will submit it so the results can be generated.
 * If a job times out and finishes later, finishRun_ will still be called,
 * but it will be handled and no results will be generated.
 *
 * @param {Object} job the job that supposedly finished.
 * @param {boolean} isRunFinished true if finished.
 * @private
 */
Client.prototype.finishRun_ = function(job, isRunFinished) {
  'use strict';
  logger.alert('Finished run %s/%s (isRunFinished=%s) of job %s',
      job.runNumber, job.runs, isRunFinished, job.id);
  if (job !== this.currentJob_) {
    // Unexpected job finish: not the current job
    logger.error('Timed-out job finished, but too late: %s', job.id);
    this.handlingUncaughtException_ = undefined;
  } else {
    var isJobFinished = (
        (job.runNumber === job.runs && isRunFinished) ||
        // Failed WPR record-run terminates the whole job.
        (job.runNumber === 0 && job.error));
    if (!isJobFinished && (
         (SIGTERM === this.handlingSignal_ ||
          SIGINT === this.handlingSignal_) ||  // Abort run
         (SIGABRT === this.handlingSignal_ && isRunFinished))) {  // Abort job
      isJobFinished = true;
      job.error = this.handlingSignal_;
    }
    // Don't submit WPR recording run.
    var shouldSubmit = (0 !== job.runNumber || job.error);

    global.clearTimeout(this.timeoutTimer_);
    this.timeoutTimer_ = undefined;
    this.currentJob_ = undefined;
    if (shouldSubmit) {
      this.submitResult_(job, isJobFinished,
          this.endOfRun_.bind(this, job, isRunFinished, isJobFinished));
    } else {
      this.endOfRun_(job, isRunFinished, isJobFinished, /*e=*/undefined);
    }
  }
};

/**
 * Wrap up a run and possibly initiate the next run.
 *
 * @param {Job} job
 * @param {boolean} isRunFinished
 * @param {boolean} isJobFinished
 * @param {Error} e
 * @private
 */
Client.prototype.endOfRun_ = function(job, isRunFinished, isJobFinished, e) {
  'use strict';
  this.handlingUncaughtException_ = undefined;
  if (e) {
    logger.error('Unable to submit result: %s', e.stack);
  }
  if (e || isJobFinished) {
    this.emit('done', job);
  } else {
    // Continue running
    if (isRunFinished) {
      if (job.runNumber >= job.runs) {  // Sanity check
        throw new Error('Internal error: job.runNumber >= job.runs');
      }
      job.runNumber += 1;
    }
    this.startNextRun_(job);
  }
};

function createFileName(job, fileName) {
  'use strict';
  return job.runNumber + (job.isCacheWarm ? '_Cached' : '') +
      ('.' !== fileName[0] ? '_' : '') + fileName;
}

function createZip(zipFileMap, fileNamer) {
  'use strict';
  var zip = new Zip();
  Object.getOwnPropertyNames(zipFileMap).forEach(function(name) {
    var content = zipFileMap[name];
    var fileName = fileNamer(name);
    logger.debug('Adding %s (%d bytes) to results zip',
        fileName, content.length);
    zip.file(fileName, content);
  });
  // Convert back and forth between base64, otherwise corrupts on long content.
  // Unfortunately node-zip does not support passing/returning Buffer.
  return new Buffer(
      zip.generate({compression: 'DEFLATE', base64: true}), 'base64');
}

/**
 * Submits one part of the job result, with an optional file.
 *
 * @private
 *
 * @param {Object} job the result file will be saved for.
 * @param {Object} resultFile of type ResultFile. May be null/undefined.
 * @param {Array=} fields an array of [name, value] text fields to add.
 * @param {Function=} callback Function({Error=} err, {string=} HTTP response
 *     body).
 */
Client.prototype.postResultFile_ = function(job, resultFile, fields, callback) {
  'use strict';
  logger.extra('postResultFile: job=%s resultFile=%s fields=%j callback=%s',
      job.id, (resultFile ? 'present' : null), fields, callback);
  var servlet = WORK_DONE_SERVLET;
  var mp = new multipart.Multipart();
  mp.addPart('id', job.id, ['Content-Type: text/plain']);
  mp.addPart('location', this.location_);
  if (this.apiKey_) {
    mp.addPart('key', this.apiKey_);
  }
  if (this.name_) {
    mp.addPart('pc', this.name_);
  } else if (this.deviceSerial_) {
    mp.addPart('pc', this.deviceSerial_);
  }
  if (fields) {
    fields.forEach(function(nameValue) {
      mp.addPart(nameValue[0], nameValue[1]);
    });
  }
  if (resultFile) {
    if (exports.ResultFile.ResultType.IMAGE === resultFile.resultType ||
        exports.ResultFile.ResultType.PCAP === resultFile.resultType) {
      // Images and pcaps must be uploaded to the RESULT_IMAGE_SERVLET, with no
      // resultType or run/cache parts.
      //
      // If we submit the pcap via the regular servlet, it would be used for
      // the waterfall instead of the DevTools trace, which we don't want.
      servlet = RESULT_IMAGE_SERVLET;
    } else {
      if (resultFile.resultType) {
        mp.addPart(resultFile.resultType, '1');
      }
      mp.addPart('_runNumber', String(job.runNumber));
      mp.addPart('_cacheWarmed', job.isCacheWarm ? '1' : '0');
    }
    var fileName = createFileName(job, resultFile.fileName);
    mp.addFilePart(
        'file', fileName, resultFile.contentType, resultFile.content);
    if (logger.isLogging('debug')) {
      logger.debug('Writing a local copy of %s', fileName);
      var body = resultFile.content;
      var bodyBuffer = (body instanceof Buffer ? body : new Buffer(body));
      fs.mkdir('results', parseInt('0755', 8), function(e) {
        if (!e || 'EEXIST' === e.code) {
          var subdir = path.join('results', job.id);
          fs.mkdir(subdir, parseInt('0755', 8), function(e) {
            if (!e || 'EEXIST' === e.code) {
              fs.writeFile(path.join(subdir, fileName), bodyBuffer);
            }
          });
        }
      });
    }
  }
  // TODO(klm): change body to chunked request.write().
  // Only makes sense if done for file content, the rest is peanuts.
  var mpResponse = mp.getHeadersAndBody();

  var options = {
      method: 'POST',
      host: this.baseUrl_.hostname,
      port: this.baseUrl_.port,
      path: this.baseUrl_.path.replace(/\/+$/, '') + '/' + servlet,
      headers: mpResponse.headers
    };
  var request = http.request(options, function(res) {
    exports.processResponse(res, callback);
  });
  request.on('error', function(e) {
    logger.warn('Unable to post result: ' + e.message);
    if (callback) {
      callback(e, '');
    }
  });
  request.end(mpResponse.bodyBuffer, 'UTF-8');
};

/**
 * submitResult_ posts all result files for the job and emits done.
 *
 * @param {Object} job that should be completed.
 * @param {boolean} isJobFinished true if job finished.
 * @param {Function=} callback Function({Error=} err).
 * @private
 */
Client.prototype.submitResult_ = function(job, isJobFinished,
      callback) {
  'use strict';
  logger.debug('submitResult_: job=%s', job.id);
  var filesToSubmit = job.resultFiles.slice();
  // If there are job.zipResultFiles, add results.zip to job.resultFiles.
  if (Object.getOwnPropertyNames(job.zipResultFiles).length > 0) {
    var zipResultFiles = job.zipResultFiles;
    job.zipResultFiles = {};
    filesToSubmit.push(new ResultFile(
        /*resultType=*/undefined,
        'results.zip',
        'application/zip',
        createZip(zipResultFiles, createFileName.bind(undefined, job))));
  }
  job.resultFiles = [];
  // Chain submitNextResult calls off of the HTTP request callback
  var submitNextResult = (function(e) {
    if (e) {
      if (callback) {
        callback(e);
      }
      return;
    }
    var resultFile = filesToSubmit.shift();
    var fields = [];
    if (resultFile) {
      if (job.error) {
        fields.push(['error', job.error]);
      }
      this.postResultFile_(job, resultFile, fields, submitNextResult);
    } else {
      if (isJobFinished) {
        fields.push(['done', '1']);
      }
      if (job.error) {
        fields.push(['testerror', job.error]);
      }
      if (fields.length) {
        this.postResultFile_(job, undefined, fields, function(e2) {
          if (callback) {
            callback(e2);
          }
        }.bind(this));
      } else if (callback) {  // Nothing to post.
        callback();
      }
    }
  }.bind(this));
  submitNextResult();
};

/**
 * Requests a job from the server and notifies listeners about the outcome.
 *
 * Event 'job' has the Job object as an argument. Calling done() on the job
 * object causes the client to submit the job result and emit 'done'.
 *
 * If the job done() does not get called within a fixed timeout, emits
 * 'timeout' with the job as an argument - to let other infrastructure clean up,
 * and then submits the job result and emits 'done'.
 *
 * @param {boolean} forever if false, make only one request. If true, chain
 *                  the request off of 'done' and 'nojob' events, running
 *                  forever or until the server responds with 'shutdown'.
 */
Client.prototype.run = function(forever) {
  'use strict';
  if (forever) {
    this.on('nojob', function() {
      this.noJobTimer_ = global.setTimeout(function() {
        this.noJobTimer_ = undefined;
        this.requestNextJob_();
      }.bind(this), exports.NO_JOB_PAUSE);
    }.bind(this));
    this.on('done', this.requestNextJob_);
  }
  this.requestNextJob_();
};

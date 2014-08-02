var d = require('d');
var bops = require('bops');
var ee = require('event-emitter');
var allOff = require('event-emitter/all-off');
var hasListeners = require('event-emitter/has-listeners');

/**
 * The default maximum buffer size.
 */
var DEFAULT_MAX_SIZE = Math.pow(2, 16); // 64k

/**
 * The set of valid encodings.
 */
var VALID_ENCODINGS = {
  utf8: true,
  hex: true,
  base64: true
};

/**
 * A robust stream implementation for node.js and the browser based on the
 * initial version of the stream API in Node.js.
 *
 * The maxSize determines the number of bytes the buffer can hold before it is
 * considered "full". Defaults to 64k.
 *
 * The source and sourceEncoding arguments may be used to easily wrap this
 * stream around another, or a simple string. If the source is another stream,
 * it is piped to this stream. If it's a string or binary data, it is used as
 * the entire contents of the stream.
 *
 * NOTE: The maxSize is a soft limit that is only used to determine when calls
 * to write will return false, indicating to streams that are writing to this
 * stream that they should pause. In any case, calls to write will still append
 * to the buffer so that no data is lost.
 */
function BufferedStream(maxSize, source, sourceEncoding) {
  if (!(this instanceof BufferedStream))
    return new BufferedStream(maxSize, source, sourceEncoding);

  if (typeof maxSize !== 'number') {
    sourceEncoding = source;
    source = maxSize;
    maxSize = DEFAULT_MAX_SIZE;
  }

  // Public interface.
  this.maxSize = maxSize;
  this.size = 0;
  this.encoding = null;
  this.paused = false;
  this.ended = false;
  this.readable = true;
  this.writable = true;

  this._chunks = [];
  this._flushing = false;
  this._wasFull = false;

  if (source != null) {
    if (typeof source.pipe === 'function') {
      source.pipe(this);
    } else {
      this.end(source, sourceEncoding);
    }
  }
}

ee(BufferedStream.prototype);

Object.defineProperties(BufferedStream.prototype, {

  /**
   * A read-only property that returns true if this stream has no data to emit.
   */
  empty: d.gs(function () {
    return this._chunks == null || this._chunks.length === 0;
  }),

  /**
   * A read-only property that returns true if this stream's buffer is full.
   */
  full: d.gs(function () {
    return this.maxSize < this.size;
  }),

  /**
   * Sets this stream's encoding. If an encoding is set, this stream will emit
   * strings using that encoding. Otherwise, it emits binary objects.
   *
   * Supported encodings are: "utf8", "hex", and "base64".
   */
  setEncoding: d(function (encoding) {
    if (VALID_ENCODINGS[encoding] !== true)
      throw new Error('Invalid encoding: ' + encoding);

    this.encoding = encoding;
  }),

  /**
   * Prevents this stream from emitting data events until resume is called.
   * Note: This does not prevent writes to this stream.
   */
  pause: d(function () {
    this.paused = true;
  }),

  /**
   * Resumes emitting data events.
   */
  resume: d(function () {
    if (this.paused)
      flushSoon(this);

    this.paused = false;
  }),

  /**
   * Pipes all data in this stream through to the given destination stream.
   * By default the destination stream is ended when this one ends. Set the
   * "end" option to `false` to disable this behavior.
   *
   * This function was copied out of node's lib/stream.js and modified for
   * use in other JavaScript environments.
   */
  pipe: d(function (dest, options) {
    var source = this;

    function ondata(chunk) {
      if (dest.writable && false === dest.write(chunk))
        source.pause();
    }

    source.on('data', ondata);

    function ondrain() {
      if (source.readable)
        source.resume();
    }

    dest.on('drain', ondrain);

    var didOnEnd = false;
    function onend() {
      if (didOnEnd) return;
      didOnEnd = true;

      dest.end();
    }

    // If the 'end' option is not supplied, dest.end() will be called when
    // source gets the 'end' or 'close' events. Only dest.end() once.
    if (!dest._isStdio && (!options || options.end !== false)) {
      source.on('end', onend);
    }

    // don't leave dangling pipes when there are errors.
    function onerror(er) {
      cleanup();
      if (!hasListeners(this, 'error')) {
        throw er; // Unhandled stream error in pipe.
      }
    }

    source.on('error', onerror);
    dest.on('error', onerror);

    // remove all the event listeners that were added.
    function cleanup() {
      source.removeListener('data', ondata);
      dest.removeListener('drain', ondrain);

      source.removeListener('end', onend);

      source.removeListener('error', onerror);
      dest.removeListener('error', onerror);

      source.removeListener('end', cleanup);
    }

    source.on('end', cleanup);
    dest.on('close', cleanup);

    dest.emit('pipe', source);

    // Allow for unix-like usage: A.pipe(B).pipe(C)
    return dest;
  }),

  // For compat with node streams && pipe.
  addListener: d(ee.methods.on),
  removeListener: d(ee.methods.off),
  removeAllListeners: d(function () {
    allOff(this);
    return this;
  }),

  /**
   * Writes the given chunk of data to this stream. Returns false if this
   * stream is full and should not be written to further until drained, true
   * otherwise.
   */
  write: d(function (chunk) {
    if (!this.writable)
      throw new Error('BufferedStream is not writable');

    if (this.ended)
      throw new Error('BufferedStream is already ended');

    if (!bops.is(chunk))
      chunk = bops.from(chunk, arguments[1]);

    this._chunks.push(chunk);
    this.size += getByteLength(chunk);

    flushSoon(this);

    if (this.full) {
      this._wasFull = true;
      return false;
    }

    return true;
  }),

  /**
   * Writes the given chunk to this stream and queues the end event to be
   * called as soon as soon as possible. If the stream is not currently
   * scheduled to be flushed, the end event will fire immediately. Otherwise, it
   * will fire after the next flush.
   */
  end: d(function (chunk) {
    if (this.ended)
      throw new Error('BufferedStream is already ended');

    if (chunk != null)
      this.write(chunk, arguments[1]);

    this.ended = true;

    // Trigger the flush cycle one last time to emit
    // any data that was written before end was called.
    flushSoon(this);
  })

});

require('setimmediate');

function flushSoon(stream) {
  if (stream._flushing)
    return;

  stream._flushing = true;

  setImmediate(function tick() {
    if (stream.paused) {
      stream._flushing = false;
      return;
    }

    flush(stream);

    if (stream.empty) {
      stream._flushing = false;
    } else {
      setImmediate(tick);
    }
  });
}

function flush(stream) {
  if (!stream._chunks)
    return;

  var chunk;
  while (chunk = stream._chunks.shift()) {
    stream.size -= getByteLength(chunk);

    if (stream.encoding) {
      stream.emit('data', bops.to(chunk, stream.encoding));
    } else {
      stream.emit('data', chunk);
    }

    // If the stream was paused in a data event handler, break.
    if (stream.paused)
      break;
  }

  if (stream.ended) {
    if (!stream.paused) {
      stream._chunks = null;
      stream.emit('end');
    }
  } else if (stream._wasFull && !stream.full) {
    stream._wasFull = false;
    stream.emit('drain');
  }
}

function getByteLength(chunk) {
  if (typeof chunk.byteLength !== 'undefined')
    return chunk.byteLength;

  return chunk.length;
}

module.exports = BufferedStream;

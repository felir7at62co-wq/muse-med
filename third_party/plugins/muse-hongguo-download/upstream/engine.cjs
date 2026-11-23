/* GPL-3.0: https://github.com/jackotom/hongguo-drama 4ffff289d6dd289e589a0fd0e65aa7aa5c2a7567; corresponding source: source.tar.gz */
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// dependencies/delayed-stream/lib/delayed_stream.js
var require_delayed_stream = __commonJS({
  "dependencies/delayed-stream/lib/delayed_stream.js"(exports2, module2) {
    var Stream = require("stream").Stream;
    var util = require("util");
    module2.exports = DelayedStream;
    function DelayedStream() {
      this.source = null;
      this.dataSize = 0;
      this.maxDataSize = 1024 * 1024;
      this.pauseStream = true;
      this._maxDataSizeExceeded = false;
      this._released = false;
      this._bufferedEvents = [];
    }
    util.inherits(DelayedStream, Stream);
    DelayedStream.create = function(source, options) {
      var delayedStream = new this();
      options = options || {};
      for (var option in options) {
        delayedStream[option] = options[option];
      }
      delayedStream.source = source;
      var realEmit = source.emit;
      source.emit = function() {
        delayedStream._handleEmit(arguments);
        return realEmit.apply(source, arguments);
      };
      source.on("error", function() {
      });
      if (delayedStream.pauseStream) {
        source.pause();
      }
      return delayedStream;
    };
    Object.defineProperty(DelayedStream.prototype, "readable", {
      configurable: true,
      enumerable: true,
      get: function() {
        return this.source.readable;
      }
    });
    DelayedStream.prototype.setEncoding = function() {
      return this.source.setEncoding.apply(this.source, arguments);
    };
    DelayedStream.prototype.resume = function() {
      if (!this._released) {
        this.release();
      }
      this.source.resume();
    };
    DelayedStream.prototype.pause = function() {
      this.source.pause();
    };
    DelayedStream.prototype.release = function() {
      this._released = true;
      this._bufferedEvents.forEach(function(args) {
        this.emit.apply(this, args);
      }.bind(this));
      this._bufferedEvents = [];
    };
    DelayedStream.prototype.pipe = function() {
      var r = Stream.prototype.pipe.apply(this, arguments);
      this.resume();
      return r;
    };
    DelayedStream.prototype._handleEmit = function(args) {
      if (this._released) {
        this.emit.apply(this, args);
        return;
      }
      if (args[0] === "data") {
        this.dataSize += args[1].length;
        this._checkIfMaxDataSizeExceeded();
      }
      this._bufferedEvents.push(args);
    };
    DelayedStream.prototype._checkIfMaxDataSizeExceeded = function() {
      if (this._maxDataSizeExceeded) {
        return;
      }
      if (this.dataSize <= this.maxDataSize) {
        return;
      }
      this._maxDataSizeExceeded = true;
      var message = "DelayedStream#maxDataSize of " + this.maxDataSize + " bytes exceeded.";
      this.emit("error", new Error(message));
    };
  }
});

// dependencies/combined-stream/lib/combined_stream.js
var require_combined_stream = __commonJS({
  "dependencies/combined-stream/lib/combined_stream.js"(exports2, module2) {
    var util = require("util");
    var Stream = require("stream").Stream;
    var DelayedStream = require_delayed_stream();
    module2.exports = CombinedStream;
    function CombinedStream() {
      this.writable = false;
      this.readable = true;
      this.dataSize = 0;
      this.maxDataSize = 2 * 1024 * 1024;
      this.pauseStreams = true;
      this._released = false;
      this._streams = [];
      this._currentStream = null;
      this._insideLoop = false;
      this._pendingNext = false;
    }
    util.inherits(CombinedStream, Stream);
    CombinedStream.create = function(options) {
      var combinedStream = new this();
      options = options || {};
      for (var option in options) {
        combinedStream[option] = options[option];
      }
      return combinedStream;
    };
    CombinedStream.isStreamLike = function(stream) {
      return typeof stream !== "function" && typeof stream !== "string" && typeof stream !== "boolean" && typeof stream !== "number" && !Buffer.isBuffer(stream);
    };
    CombinedStream.prototype.append = function(stream) {
      var isStreamLike = CombinedStream.isStreamLike(stream);
      if (isStreamLike) {
        if (!(stream instanceof DelayedStream)) {
          var newStream = DelayedStream.create(stream, {
            maxDataSize: Infinity,
            pauseStream: this.pauseStreams
          });
          stream.on("data", this._checkDataSize.bind(this));
          stream = newStream;
        }
        this._handleErrors(stream);
        if (this.pauseStreams) {
          stream.pause();
        }
      }
      this._streams.push(stream);
      return this;
    };
    CombinedStream.prototype.pipe = function(dest, options) {
      Stream.prototype.pipe.call(this, dest, options);
      this.resume();
      return dest;
    };
    CombinedStream.prototype._getNext = function() {
      this._currentStream = null;
      if (this._insideLoop) {
        this._pendingNext = true;
        return;
      }
      this._insideLoop = true;
      try {
        do {
          this._pendingNext = false;
          this._realGetNext();
        } while (this._pendingNext);
      } finally {
        this._insideLoop = false;
      }
    };
    CombinedStream.prototype._realGetNext = function() {
      var stream = this._streams.shift();
      if (typeof stream == "undefined") {
        this.end();
        return;
      }
      if (typeof stream !== "function") {
        this._pipeNext(stream);
        return;
      }
      var getStream = stream;
      getStream(function(stream2) {
        var isStreamLike = CombinedStream.isStreamLike(stream2);
        if (isStreamLike) {
          stream2.on("data", this._checkDataSize.bind(this));
          this._handleErrors(stream2);
        }
        this._pipeNext(stream2);
      }.bind(this));
    };
    CombinedStream.prototype._pipeNext = function(stream) {
      this._currentStream = stream;
      var isStreamLike = CombinedStream.isStreamLike(stream);
      if (isStreamLike) {
        stream.on("end", this._getNext.bind(this));
        stream.pipe(this, { end: false });
        return;
      }
      var value = stream;
      this.write(value);
      this._getNext();
    };
    CombinedStream.prototype._handleErrors = function(stream) {
      var self2 = this;
      stream.on("error", function(err) {
        self2._emitError(err);
      });
    };
    CombinedStream.prototype.write = function(data) {
      this.emit("data", data);
    };
    CombinedStream.prototype.pause = function() {
      if (!this.pauseStreams) {
        return;
      }
      if (this.pauseStreams && this._currentStream && typeof this._currentStream.pause == "function") this._currentStream.pause();
      this.emit("pause");
    };
    CombinedStream.prototype.resume = function() {
      if (!this._released) {
        this._released = true;
        this.writable = true;
        this._getNext();
      }
      if (this.pauseStreams && this._currentStream && typeof this._currentStream.resume == "function") this._currentStream.resume();
      this.emit("resume");
    };
    CombinedStream.prototype.end = function() {
      this._reset();
      this.emit("end");
    };
    CombinedStream.prototype.destroy = function() {
      this._reset();
      this.emit("close");
    };
    CombinedStream.prototype._reset = function() {
      this.writable = false;
      this._streams = [];
      this._currentStream = null;
    };
    CombinedStream.prototype._checkDataSize = function() {
      this._updateDataSize();
      if (this.dataSize <= this.maxDataSize) {
        return;
      }
      var message = "DelayedStream#maxDataSize of " + this.maxDataSize + " bytes exceeded.";
      this._emitError(new Error(message));
    };
    CombinedStream.prototype._updateDataSize = function() {
      this.dataSize = 0;
      var self2 = this;
      this._streams.forEach(function(stream) {
        if (!stream.dataSize) {
          return;
        }
        self2.dataSize += stream.dataSize;
      });
      if (this._currentStream && this._currentStream.dataSize) {
        this.dataSize += this._currentStream.dataSize;
      }
    };
    CombinedStream.prototype._emitError = function(err) {
      this._reset();
      this.emit("error", err);
    };
  }
});

// dependencies/mime-db/db.json
var require_db = __commonJS({
  "dependencies/mime-db/db.json"(exports2, module2) {
    module2.exports = {
      "application/1d-interleaved-parityfec": {
        source: "iana"
      },
      "application/3gpdash-qoe-report+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/3gpp-ims+xml": {
        source: "iana",
        compressible: true
      },
      "application/3gpphal+json": {
        source: "iana",
        compressible: true
      },
      "application/3gpphalforms+json": {
        source: "iana",
        compressible: true
      },
      "application/a2l": {
        source: "iana"
      },
      "application/ace+cbor": {
        source: "iana"
      },
      "application/activemessage": {
        source: "iana"
      },
      "application/activity+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-costmap+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-costmapfilter+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-directory+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-endpointcost+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-endpointcostparams+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-endpointprop+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-endpointpropparams+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-error+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-networkmap+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-networkmapfilter+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-updatestreamcontrol+json": {
        source: "iana",
        compressible: true
      },
      "application/alto-updatestreamparams+json": {
        source: "iana",
        compressible: true
      },
      "application/aml": {
        source: "iana"
      },
      "application/andrew-inset": {
        source: "iana",
        extensions: ["ez"]
      },
      "application/applefile": {
        source: "iana"
      },
      "application/applixware": {
        source: "apache",
        extensions: ["aw"]
      },
      "application/at+jwt": {
        source: "iana"
      },
      "application/atf": {
        source: "iana"
      },
      "application/atfx": {
        source: "iana"
      },
      "application/atom+xml": {
        source: "iana",
        compressible: true,
        extensions: ["atom"]
      },
      "application/atomcat+xml": {
        source: "iana",
        compressible: true,
        extensions: ["atomcat"]
      },
      "application/atomdeleted+xml": {
        source: "iana",
        compressible: true,
        extensions: ["atomdeleted"]
      },
      "application/atomicmail": {
        source: "iana"
      },
      "application/atomsvc+xml": {
        source: "iana",
        compressible: true,
        extensions: ["atomsvc"]
      },
      "application/atsc-dwd+xml": {
        source: "iana",
        compressible: true,
        extensions: ["dwd"]
      },
      "application/atsc-dynamic-event-message": {
        source: "iana"
      },
      "application/atsc-held+xml": {
        source: "iana",
        compressible: true,
        extensions: ["held"]
      },
      "application/atsc-rdt+json": {
        source: "iana",
        compressible: true
      },
      "application/atsc-rsat+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rsat"]
      },
      "application/atxml": {
        source: "iana"
      },
      "application/auth-policy+xml": {
        source: "iana",
        compressible: true
      },
      "application/bacnet-xdd+zip": {
        source: "iana",
        compressible: false
      },
      "application/batch-smtp": {
        source: "iana"
      },
      "application/bdoc": {
        compressible: false,
        extensions: ["bdoc"]
      },
      "application/beep+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/calendar+json": {
        source: "iana",
        compressible: true
      },
      "application/calendar+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xcs"]
      },
      "application/call-completion": {
        source: "iana"
      },
      "application/cals-1840": {
        source: "iana"
      },
      "application/captive+json": {
        source: "iana",
        compressible: true
      },
      "application/cbor": {
        source: "iana"
      },
      "application/cbor-seq": {
        source: "iana"
      },
      "application/cccex": {
        source: "iana"
      },
      "application/ccmp+xml": {
        source: "iana",
        compressible: true
      },
      "application/ccxml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["ccxml"]
      },
      "application/cdfx+xml": {
        source: "iana",
        compressible: true,
        extensions: ["cdfx"]
      },
      "application/cdmi-capability": {
        source: "iana",
        extensions: ["cdmia"]
      },
      "application/cdmi-container": {
        source: "iana",
        extensions: ["cdmic"]
      },
      "application/cdmi-domain": {
        source: "iana",
        extensions: ["cdmid"]
      },
      "application/cdmi-object": {
        source: "iana",
        extensions: ["cdmio"]
      },
      "application/cdmi-queue": {
        source: "iana",
        extensions: ["cdmiq"]
      },
      "application/cdni": {
        source: "iana"
      },
      "application/cea": {
        source: "iana"
      },
      "application/cea-2018+xml": {
        source: "iana",
        compressible: true
      },
      "application/cellml+xml": {
        source: "iana",
        compressible: true
      },
      "application/cfw": {
        source: "iana"
      },
      "application/city+json": {
        source: "iana",
        compressible: true
      },
      "application/clr": {
        source: "iana"
      },
      "application/clue+xml": {
        source: "iana",
        compressible: true
      },
      "application/clue_info+xml": {
        source: "iana",
        compressible: true
      },
      "application/cms": {
        source: "iana"
      },
      "application/cnrp+xml": {
        source: "iana",
        compressible: true
      },
      "application/coap-group+json": {
        source: "iana",
        compressible: true
      },
      "application/coap-payload": {
        source: "iana"
      },
      "application/commonground": {
        source: "iana"
      },
      "application/conference-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/cose": {
        source: "iana"
      },
      "application/cose-key": {
        source: "iana"
      },
      "application/cose-key-set": {
        source: "iana"
      },
      "application/cpl+xml": {
        source: "iana",
        compressible: true,
        extensions: ["cpl"]
      },
      "application/csrattrs": {
        source: "iana"
      },
      "application/csta+xml": {
        source: "iana",
        compressible: true
      },
      "application/cstadata+xml": {
        source: "iana",
        compressible: true
      },
      "application/csvm+json": {
        source: "iana",
        compressible: true
      },
      "application/cu-seeme": {
        source: "apache",
        extensions: ["cu"]
      },
      "application/cwt": {
        source: "iana"
      },
      "application/cybercash": {
        source: "iana"
      },
      "application/dart": {
        compressible: true
      },
      "application/dash+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mpd"]
      },
      "application/dash-patch+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mpp"]
      },
      "application/dashdelta": {
        source: "iana"
      },
      "application/davmount+xml": {
        source: "iana",
        compressible: true,
        extensions: ["davmount"]
      },
      "application/dca-rft": {
        source: "iana"
      },
      "application/dcd": {
        source: "iana"
      },
      "application/dec-dx": {
        source: "iana"
      },
      "application/dialog-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/dicom": {
        source: "iana"
      },
      "application/dicom+json": {
        source: "iana",
        compressible: true
      },
      "application/dicom+xml": {
        source: "iana",
        compressible: true
      },
      "application/dii": {
        source: "iana"
      },
      "application/dit": {
        source: "iana"
      },
      "application/dns": {
        source: "iana"
      },
      "application/dns+json": {
        source: "iana",
        compressible: true
      },
      "application/dns-message": {
        source: "iana"
      },
      "application/docbook+xml": {
        source: "apache",
        compressible: true,
        extensions: ["dbk"]
      },
      "application/dots+cbor": {
        source: "iana"
      },
      "application/dskpp+xml": {
        source: "iana",
        compressible: true
      },
      "application/dssc+der": {
        source: "iana",
        extensions: ["dssc"]
      },
      "application/dssc+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xdssc"]
      },
      "application/dvcs": {
        source: "iana"
      },
      "application/ecmascript": {
        source: "iana",
        compressible: true,
        extensions: ["es", "ecma"]
      },
      "application/edi-consent": {
        source: "iana"
      },
      "application/edi-x12": {
        source: "iana",
        compressible: false
      },
      "application/edifact": {
        source: "iana",
        compressible: false
      },
      "application/efi": {
        source: "iana"
      },
      "application/elm+json": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/elm+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.cap+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/emergencycalldata.comment+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.control+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.deviceinfo+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.ecall.msd": {
        source: "iana"
      },
      "application/emergencycalldata.providerinfo+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.serviceinfo+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.subscriberinfo+xml": {
        source: "iana",
        compressible: true
      },
      "application/emergencycalldata.veds+xml": {
        source: "iana",
        compressible: true
      },
      "application/emma+xml": {
        source: "iana",
        compressible: true,
        extensions: ["emma"]
      },
      "application/emotionml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["emotionml"]
      },
      "application/encaprtp": {
        source: "iana"
      },
      "application/epp+xml": {
        source: "iana",
        compressible: true
      },
      "application/epub+zip": {
        source: "iana",
        compressible: false,
        extensions: ["epub"]
      },
      "application/eshop": {
        source: "iana"
      },
      "application/exi": {
        source: "iana",
        extensions: ["exi"]
      },
      "application/expect-ct-report+json": {
        source: "iana",
        compressible: true
      },
      "application/express": {
        source: "iana",
        extensions: ["exp"]
      },
      "application/fastinfoset": {
        source: "iana"
      },
      "application/fastsoap": {
        source: "iana"
      },
      "application/fdt+xml": {
        source: "iana",
        compressible: true,
        extensions: ["fdt"]
      },
      "application/fhir+json": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/fhir+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/fido.trusted-apps+json": {
        compressible: true
      },
      "application/fits": {
        source: "iana"
      },
      "application/flexfec": {
        source: "iana"
      },
      "application/font-sfnt": {
        source: "iana"
      },
      "application/font-tdpfr": {
        source: "iana",
        extensions: ["pfr"]
      },
      "application/font-woff": {
        source: "iana",
        compressible: false
      },
      "application/framework-attributes+xml": {
        source: "iana",
        compressible: true
      },
      "application/geo+json": {
        source: "iana",
        compressible: true,
        extensions: ["geojson"]
      },
      "application/geo+json-seq": {
        source: "iana"
      },
      "application/geopackage+sqlite3": {
        source: "iana"
      },
      "application/geoxacml+xml": {
        source: "iana",
        compressible: true
      },
      "application/gltf-buffer": {
        source: "iana"
      },
      "application/gml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["gml"]
      },
      "application/gpx+xml": {
        source: "apache",
        compressible: true,
        extensions: ["gpx"]
      },
      "application/gxf": {
        source: "apache",
        extensions: ["gxf"]
      },
      "application/gzip": {
        source: "iana",
        compressible: false,
        extensions: ["gz"]
      },
      "application/h224": {
        source: "iana"
      },
      "application/held+xml": {
        source: "iana",
        compressible: true
      },
      "application/hjson": {
        extensions: ["hjson"]
      },
      "application/http": {
        source: "iana"
      },
      "application/hyperstudio": {
        source: "iana",
        extensions: ["stk"]
      },
      "application/ibe-key-request+xml": {
        source: "iana",
        compressible: true
      },
      "application/ibe-pkg-reply+xml": {
        source: "iana",
        compressible: true
      },
      "application/ibe-pp-data": {
        source: "iana"
      },
      "application/iges": {
        source: "iana"
      },
      "application/im-iscomposing+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/index": {
        source: "iana"
      },
      "application/index.cmd": {
        source: "iana"
      },
      "application/index.obj": {
        source: "iana"
      },
      "application/index.response": {
        source: "iana"
      },
      "application/index.vnd": {
        source: "iana"
      },
      "application/inkml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["ink", "inkml"]
      },
      "application/iotp": {
        source: "iana"
      },
      "application/ipfix": {
        source: "iana",
        extensions: ["ipfix"]
      },
      "application/ipp": {
        source: "iana"
      },
      "application/isup": {
        source: "iana"
      },
      "application/its+xml": {
        source: "iana",
        compressible: true,
        extensions: ["its"]
      },
      "application/java-archive": {
        source: "apache",
        compressible: false,
        extensions: ["jar", "war", "ear"]
      },
      "application/java-serialized-object": {
        source: "apache",
        compressible: false,
        extensions: ["ser"]
      },
      "application/java-vm": {
        source: "apache",
        compressible: false,
        extensions: ["class"]
      },
      "application/javascript": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["js", "mjs"]
      },
      "application/jf2feed+json": {
        source: "iana",
        compressible: true
      },
      "application/jose": {
        source: "iana"
      },
      "application/jose+json": {
        source: "iana",
        compressible: true
      },
      "application/jrd+json": {
        source: "iana",
        compressible: true
      },
      "application/jscalendar+json": {
        source: "iana",
        compressible: true
      },
      "application/json": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["json", "map"]
      },
      "application/json-patch+json": {
        source: "iana",
        compressible: true
      },
      "application/json-seq": {
        source: "iana"
      },
      "application/json5": {
        extensions: ["json5"]
      },
      "application/jsonml+json": {
        source: "apache",
        compressible: true,
        extensions: ["jsonml"]
      },
      "application/jwk+json": {
        source: "iana",
        compressible: true
      },
      "application/jwk-set+json": {
        source: "iana",
        compressible: true
      },
      "application/jwt": {
        source: "iana"
      },
      "application/kpml-request+xml": {
        source: "iana",
        compressible: true
      },
      "application/kpml-response+xml": {
        source: "iana",
        compressible: true
      },
      "application/ld+json": {
        source: "iana",
        compressible: true,
        extensions: ["jsonld"]
      },
      "application/lgr+xml": {
        source: "iana",
        compressible: true,
        extensions: ["lgr"]
      },
      "application/link-format": {
        source: "iana"
      },
      "application/load-control+xml": {
        source: "iana",
        compressible: true
      },
      "application/lost+xml": {
        source: "iana",
        compressible: true,
        extensions: ["lostxml"]
      },
      "application/lostsync+xml": {
        source: "iana",
        compressible: true
      },
      "application/lpf+zip": {
        source: "iana",
        compressible: false
      },
      "application/lxf": {
        source: "iana"
      },
      "application/mac-binhex40": {
        source: "iana",
        extensions: ["hqx"]
      },
      "application/mac-compactpro": {
        source: "apache",
        extensions: ["cpt"]
      },
      "application/macwriteii": {
        source: "iana"
      },
      "application/mads+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mads"]
      },
      "application/manifest+json": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["webmanifest"]
      },
      "application/marc": {
        source: "iana",
        extensions: ["mrc"]
      },
      "application/marcxml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mrcx"]
      },
      "application/mathematica": {
        source: "iana",
        extensions: ["ma", "nb", "mb"]
      },
      "application/mathml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mathml"]
      },
      "application/mathml-content+xml": {
        source: "iana",
        compressible: true
      },
      "application/mathml-presentation+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-associated-procedure-description+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-deregister+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-envelope+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-msk+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-msk-response+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-protection-description+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-reception-report+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-register+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-register-response+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-schedule+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbms-user-service-description+xml": {
        source: "iana",
        compressible: true
      },
      "application/mbox": {
        source: "iana",
        extensions: ["mbox"]
      },
      "application/media-policy-dataset+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mpf"]
      },
      "application/media_control+xml": {
        source: "iana",
        compressible: true
      },
      "application/mediaservercontrol+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mscml"]
      },
      "application/merge-patch+json": {
        source: "iana",
        compressible: true
      },
      "application/metalink+xml": {
        source: "apache",
        compressible: true,
        extensions: ["metalink"]
      },
      "application/metalink4+xml": {
        source: "iana",
        compressible: true,
        extensions: ["meta4"]
      },
      "application/mets+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mets"]
      },
      "application/mf4": {
        source: "iana"
      },
      "application/mikey": {
        source: "iana"
      },
      "application/mipc": {
        source: "iana"
      },
      "application/missing-blocks+cbor-seq": {
        source: "iana"
      },
      "application/mmt-aei+xml": {
        source: "iana",
        compressible: true,
        extensions: ["maei"]
      },
      "application/mmt-usd+xml": {
        source: "iana",
        compressible: true,
        extensions: ["musd"]
      },
      "application/mods+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mods"]
      },
      "application/moss-keys": {
        source: "iana"
      },
      "application/moss-signature": {
        source: "iana"
      },
      "application/mosskey-data": {
        source: "iana"
      },
      "application/mosskey-request": {
        source: "iana"
      },
      "application/mp21": {
        source: "iana",
        extensions: ["m21", "mp21"]
      },
      "application/mp4": {
        source: "iana",
        extensions: ["mp4s", "m4p"]
      },
      "application/mpeg4-generic": {
        source: "iana"
      },
      "application/mpeg4-iod": {
        source: "iana"
      },
      "application/mpeg4-iod-xmt": {
        source: "iana"
      },
      "application/mrb-consumer+xml": {
        source: "iana",
        compressible: true
      },
      "application/mrb-publish+xml": {
        source: "iana",
        compressible: true
      },
      "application/msc-ivr+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/msc-mixer+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/msword": {
        source: "iana",
        compressible: false,
        extensions: ["doc", "dot"]
      },
      "application/mud+json": {
        source: "iana",
        compressible: true
      },
      "application/multipart-core": {
        source: "iana"
      },
      "application/mxf": {
        source: "iana",
        extensions: ["mxf"]
      },
      "application/n-quads": {
        source: "iana",
        extensions: ["nq"]
      },
      "application/n-triples": {
        source: "iana",
        extensions: ["nt"]
      },
      "application/nasdata": {
        source: "iana"
      },
      "application/news-checkgroups": {
        source: "iana",
        charset: "US-ASCII"
      },
      "application/news-groupinfo": {
        source: "iana",
        charset: "US-ASCII"
      },
      "application/news-transmission": {
        source: "iana"
      },
      "application/nlsml+xml": {
        source: "iana",
        compressible: true
      },
      "application/node": {
        source: "iana",
        extensions: ["cjs"]
      },
      "application/nss": {
        source: "iana"
      },
      "application/oauth-authz-req+jwt": {
        source: "iana"
      },
      "application/oblivious-dns-message": {
        source: "iana"
      },
      "application/ocsp-request": {
        source: "iana"
      },
      "application/ocsp-response": {
        source: "iana"
      },
      "application/octet-stream": {
        source: "iana",
        compressible: false,
        extensions: ["bin", "dms", "lrf", "mar", "so", "dist", "distz", "pkg", "bpk", "dump", "elc", "deploy", "exe", "dll", "deb", "dmg", "iso", "img", "msi", "msp", "msm", "buffer"]
      },
      "application/oda": {
        source: "iana",
        extensions: ["oda"]
      },
      "application/odm+xml": {
        source: "iana",
        compressible: true
      },
      "application/odx": {
        source: "iana"
      },
      "application/oebps-package+xml": {
        source: "iana",
        compressible: true,
        extensions: ["opf"]
      },
      "application/ogg": {
        source: "iana",
        compressible: false,
        extensions: ["ogx"]
      },
      "application/omdoc+xml": {
        source: "apache",
        compressible: true,
        extensions: ["omdoc"]
      },
      "application/onenote": {
        source: "apache",
        extensions: ["onetoc", "onetoc2", "onetmp", "onepkg"]
      },
      "application/opc-nodeset+xml": {
        source: "iana",
        compressible: true
      },
      "application/oscore": {
        source: "iana"
      },
      "application/oxps": {
        source: "iana",
        extensions: ["oxps"]
      },
      "application/p21": {
        source: "iana"
      },
      "application/p21+zip": {
        source: "iana",
        compressible: false
      },
      "application/p2p-overlay+xml": {
        source: "iana",
        compressible: true,
        extensions: ["relo"]
      },
      "application/parityfec": {
        source: "iana"
      },
      "application/passport": {
        source: "iana"
      },
      "application/patch-ops-error+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xer"]
      },
      "application/pdf": {
        source: "iana",
        compressible: false,
        extensions: ["pdf"]
      },
      "application/pdx": {
        source: "iana"
      },
      "application/pem-certificate-chain": {
        source: "iana"
      },
      "application/pgp-encrypted": {
        source: "iana",
        compressible: false,
        extensions: ["pgp"]
      },
      "application/pgp-keys": {
        source: "iana",
        extensions: ["asc"]
      },
      "application/pgp-signature": {
        source: "iana",
        extensions: ["asc", "sig"]
      },
      "application/pics-rules": {
        source: "apache",
        extensions: ["prf"]
      },
      "application/pidf+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/pidf-diff+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/pkcs10": {
        source: "iana",
        extensions: ["p10"]
      },
      "application/pkcs12": {
        source: "iana"
      },
      "application/pkcs7-mime": {
        source: "iana",
        extensions: ["p7m", "p7c"]
      },
      "application/pkcs7-signature": {
        source: "iana",
        extensions: ["p7s"]
      },
      "application/pkcs8": {
        source: "iana",
        extensions: ["p8"]
      },
      "application/pkcs8-encrypted": {
        source: "iana"
      },
      "application/pkix-attr-cert": {
        source: "iana",
        extensions: ["ac"]
      },
      "application/pkix-cert": {
        source: "iana",
        extensions: ["cer"]
      },
      "application/pkix-crl": {
        source: "iana",
        extensions: ["crl"]
      },
      "application/pkix-pkipath": {
        source: "iana",
        extensions: ["pkipath"]
      },
      "application/pkixcmp": {
        source: "iana",
        extensions: ["pki"]
      },
      "application/pls+xml": {
        source: "iana",
        compressible: true,
        extensions: ["pls"]
      },
      "application/poc-settings+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/postscript": {
        source: "iana",
        compressible: true,
        extensions: ["ai", "eps", "ps"]
      },
      "application/ppsp-tracker+json": {
        source: "iana",
        compressible: true
      },
      "application/problem+json": {
        source: "iana",
        compressible: true
      },
      "application/problem+xml": {
        source: "iana",
        compressible: true
      },
      "application/provenance+xml": {
        source: "iana",
        compressible: true,
        extensions: ["provx"]
      },
      "application/prs.alvestrand.titrax-sheet": {
        source: "iana"
      },
      "application/prs.cww": {
        source: "iana",
        extensions: ["cww"]
      },
      "application/prs.cyn": {
        source: "iana",
        charset: "7-BIT"
      },
      "application/prs.hpub+zip": {
        source: "iana",
        compressible: false
      },
      "application/prs.nprend": {
        source: "iana"
      },
      "application/prs.plucker": {
        source: "iana"
      },
      "application/prs.rdf-xml-crypt": {
        source: "iana"
      },
      "application/prs.xsf+xml": {
        source: "iana",
        compressible: true
      },
      "application/pskc+xml": {
        source: "iana",
        compressible: true,
        extensions: ["pskcxml"]
      },
      "application/pvd+json": {
        source: "iana",
        compressible: true
      },
      "application/qsig": {
        source: "iana"
      },
      "application/raml+yaml": {
        compressible: true,
        extensions: ["raml"]
      },
      "application/raptorfec": {
        source: "iana"
      },
      "application/rdap+json": {
        source: "iana",
        compressible: true
      },
      "application/rdf+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rdf", "owl"]
      },
      "application/reginfo+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rif"]
      },
      "application/relax-ng-compact-syntax": {
        source: "iana",
        extensions: ["rnc"]
      },
      "application/remote-printing": {
        source: "iana"
      },
      "application/reputon+json": {
        source: "iana",
        compressible: true
      },
      "application/resource-lists+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rl"]
      },
      "application/resource-lists-diff+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rld"]
      },
      "application/rfc+xml": {
        source: "iana",
        compressible: true
      },
      "application/riscos": {
        source: "iana"
      },
      "application/rlmi+xml": {
        source: "iana",
        compressible: true
      },
      "application/rls-services+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rs"]
      },
      "application/route-apd+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rapd"]
      },
      "application/route-s-tsid+xml": {
        source: "iana",
        compressible: true,
        extensions: ["sls"]
      },
      "application/route-usd+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rusd"]
      },
      "application/rpki-ghostbusters": {
        source: "iana",
        extensions: ["gbr"]
      },
      "application/rpki-manifest": {
        source: "iana",
        extensions: ["mft"]
      },
      "application/rpki-publication": {
        source: "iana"
      },
      "application/rpki-roa": {
        source: "iana",
        extensions: ["roa"]
      },
      "application/rpki-updown": {
        source: "iana"
      },
      "application/rsd+xml": {
        source: "apache",
        compressible: true,
        extensions: ["rsd"]
      },
      "application/rss+xml": {
        source: "apache",
        compressible: true,
        extensions: ["rss"]
      },
      "application/rtf": {
        source: "iana",
        compressible: true,
        extensions: ["rtf"]
      },
      "application/rtploopback": {
        source: "iana"
      },
      "application/rtx": {
        source: "iana"
      },
      "application/samlassertion+xml": {
        source: "iana",
        compressible: true
      },
      "application/samlmetadata+xml": {
        source: "iana",
        compressible: true
      },
      "application/sarif+json": {
        source: "iana",
        compressible: true
      },
      "application/sarif-external-properties+json": {
        source: "iana",
        compressible: true
      },
      "application/sbe": {
        source: "iana"
      },
      "application/sbml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["sbml"]
      },
      "application/scaip+xml": {
        source: "iana",
        compressible: true
      },
      "application/scim+json": {
        source: "iana",
        compressible: true
      },
      "application/scvp-cv-request": {
        source: "iana",
        extensions: ["scq"]
      },
      "application/scvp-cv-response": {
        source: "iana",
        extensions: ["scs"]
      },
      "application/scvp-vp-request": {
        source: "iana",
        extensions: ["spq"]
      },
      "application/scvp-vp-response": {
        source: "iana",
        extensions: ["spp"]
      },
      "application/sdp": {
        source: "iana",
        extensions: ["sdp"]
      },
      "application/secevent+jwt": {
        source: "iana"
      },
      "application/senml+cbor": {
        source: "iana"
      },
      "application/senml+json": {
        source: "iana",
        compressible: true
      },
      "application/senml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["senmlx"]
      },
      "application/senml-etch+cbor": {
        source: "iana"
      },
      "application/senml-etch+json": {
        source: "iana",
        compressible: true
      },
      "application/senml-exi": {
        source: "iana"
      },
      "application/sensml+cbor": {
        source: "iana"
      },
      "application/sensml+json": {
        source: "iana",
        compressible: true
      },
      "application/sensml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["sensmlx"]
      },
      "application/sensml-exi": {
        source: "iana"
      },
      "application/sep+xml": {
        source: "iana",
        compressible: true
      },
      "application/sep-exi": {
        source: "iana"
      },
      "application/session-info": {
        source: "iana"
      },
      "application/set-payment": {
        source: "iana"
      },
      "application/set-payment-initiation": {
        source: "iana",
        extensions: ["setpay"]
      },
      "application/set-registration": {
        source: "iana"
      },
      "application/set-registration-initiation": {
        source: "iana",
        extensions: ["setreg"]
      },
      "application/sgml": {
        source: "iana"
      },
      "application/sgml-open-catalog": {
        source: "iana"
      },
      "application/shf+xml": {
        source: "iana",
        compressible: true,
        extensions: ["shf"]
      },
      "application/sieve": {
        source: "iana",
        extensions: ["siv", "sieve"]
      },
      "application/simple-filter+xml": {
        source: "iana",
        compressible: true
      },
      "application/simple-message-summary": {
        source: "iana"
      },
      "application/simplesymbolcontainer": {
        source: "iana"
      },
      "application/sipc": {
        source: "iana"
      },
      "application/slate": {
        source: "iana"
      },
      "application/smil": {
        source: "iana"
      },
      "application/smil+xml": {
        source: "iana",
        compressible: true,
        extensions: ["smi", "smil"]
      },
      "application/smpte336m": {
        source: "iana"
      },
      "application/soap+fastinfoset": {
        source: "iana"
      },
      "application/soap+xml": {
        source: "iana",
        compressible: true
      },
      "application/sparql-query": {
        source: "iana",
        extensions: ["rq"]
      },
      "application/sparql-results+xml": {
        source: "iana",
        compressible: true,
        extensions: ["srx"]
      },
      "application/spdx+json": {
        source: "iana",
        compressible: true
      },
      "application/spirits-event+xml": {
        source: "iana",
        compressible: true
      },
      "application/sql": {
        source: "iana"
      },
      "application/srgs": {
        source: "iana",
        extensions: ["gram"]
      },
      "application/srgs+xml": {
        source: "iana",
        compressible: true,
        extensions: ["grxml"]
      },
      "application/sru+xml": {
        source: "iana",
        compressible: true,
        extensions: ["sru"]
      },
      "application/ssdl+xml": {
        source: "apache",
        compressible: true,
        extensions: ["ssdl"]
      },
      "application/ssml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["ssml"]
      },
      "application/stix+json": {
        source: "iana",
        compressible: true
      },
      "application/swid+xml": {
        source: "iana",
        compressible: true,
        extensions: ["swidtag"]
      },
      "application/tamp-apex-update": {
        source: "iana"
      },
      "application/tamp-apex-update-confirm": {
        source: "iana"
      },
      "application/tamp-community-update": {
        source: "iana"
      },
      "application/tamp-community-update-confirm": {
        source: "iana"
      },
      "application/tamp-error": {
        source: "iana"
      },
      "application/tamp-sequence-adjust": {
        source: "iana"
      },
      "application/tamp-sequence-adjust-confirm": {
        source: "iana"
      },
      "application/tamp-status-query": {
        source: "iana"
      },
      "application/tamp-status-response": {
        source: "iana"
      },
      "application/tamp-update": {
        source: "iana"
      },
      "application/tamp-update-confirm": {
        source: "iana"
      },
      "application/tar": {
        compressible: true
      },
      "application/taxii+json": {
        source: "iana",
        compressible: true
      },
      "application/td+json": {
        source: "iana",
        compressible: true
      },
      "application/tei+xml": {
        source: "iana",
        compressible: true,
        extensions: ["tei", "teicorpus"]
      },
      "application/tetra_isi": {
        source: "iana"
      },
      "application/thraud+xml": {
        source: "iana",
        compressible: true,
        extensions: ["tfi"]
      },
      "application/timestamp-query": {
        source: "iana"
      },
      "application/timestamp-reply": {
        source: "iana"
      },
      "application/timestamped-data": {
        source: "iana",
        extensions: ["tsd"]
      },
      "application/tlsrpt+gzip": {
        source: "iana"
      },
      "application/tlsrpt+json": {
        source: "iana",
        compressible: true
      },
      "application/tnauthlist": {
        source: "iana"
      },
      "application/token-introspection+jwt": {
        source: "iana"
      },
      "application/toml": {
        compressible: true,
        extensions: ["toml"]
      },
      "application/trickle-ice-sdpfrag": {
        source: "iana"
      },
      "application/trig": {
        source: "iana",
        extensions: ["trig"]
      },
      "application/ttml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["ttml"]
      },
      "application/tve-trigger": {
        source: "iana"
      },
      "application/tzif": {
        source: "iana"
      },
      "application/tzif-leap": {
        source: "iana"
      },
      "application/ubjson": {
        compressible: false,
        extensions: ["ubj"]
      },
      "application/ulpfec": {
        source: "iana"
      },
      "application/urc-grpsheet+xml": {
        source: "iana",
        compressible: true
      },
      "application/urc-ressheet+xml": {
        source: "iana",
        compressible: true,
        extensions: ["rsheet"]
      },
      "application/urc-targetdesc+xml": {
        source: "iana",
        compressible: true,
        extensions: ["td"]
      },
      "application/urc-uisocketdesc+xml": {
        source: "iana",
        compressible: true
      },
      "application/vcard+json": {
        source: "iana",
        compressible: true
      },
      "application/vcard+xml": {
        source: "iana",
        compressible: true
      },
      "application/vemmi": {
        source: "iana"
      },
      "application/vividence.scriptfile": {
        source: "apache"
      },
      "application/vnd.1000minds.decision-model+xml": {
        source: "iana",
        compressible: true,
        extensions: ["1km"]
      },
      "application/vnd.3gpp-prose+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp-prose-pc3ch+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp-v2x-local-service-information": {
        source: "iana"
      },
      "application/vnd.3gpp.5gnas": {
        source: "iana"
      },
      "application/vnd.3gpp.access-transfer-events+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.bsf+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.gmop+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.gtpc": {
        source: "iana"
      },
      "application/vnd.3gpp.interworking-data": {
        source: "iana"
      },
      "application/vnd.3gpp.lpp": {
        source: "iana"
      },
      "application/vnd.3gpp.mc-signalling-ear": {
        source: "iana"
      },
      "application/vnd.3gpp.mcdata-affiliation-command+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcdata-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcdata-payload": {
        source: "iana"
      },
      "application/vnd.3gpp.mcdata-service-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcdata-signalling": {
        source: "iana"
      },
      "application/vnd.3gpp.mcdata-ue-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcdata-user-profile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-affiliation-command+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-floor-request+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-location-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-mbms-usage-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-service-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-signed+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-ue-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-ue-init-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcptt-user-profile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-affiliation-command+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-affiliation-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-location-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-mbms-usage-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-service-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-transmission-request+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-ue-config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mcvideo-user-profile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.mid-call+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.ngap": {
        source: "iana"
      },
      "application/vnd.3gpp.pfcp": {
        source: "iana"
      },
      "application/vnd.3gpp.pic-bw-large": {
        source: "iana",
        extensions: ["plb"]
      },
      "application/vnd.3gpp.pic-bw-small": {
        source: "iana",
        extensions: ["psb"]
      },
      "application/vnd.3gpp.pic-bw-var": {
        source: "iana",
        extensions: ["pvb"]
      },
      "application/vnd.3gpp.s1ap": {
        source: "iana"
      },
      "application/vnd.3gpp.sms": {
        source: "iana"
      },
      "application/vnd.3gpp.sms+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.srvcc-ext+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.srvcc-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.state-and-event-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp.ussd+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp2.bcmcsinfo+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.3gpp2.sms": {
        source: "iana"
      },
      "application/vnd.3gpp2.tcap": {
        source: "iana",
        extensions: ["tcap"]
      },
      "application/vnd.3lightssoftware.imagescal": {
        source: "iana"
      },
      "application/vnd.3m.post-it-notes": {
        source: "iana",
        extensions: ["pwn"]
      },
      "application/vnd.accpac.simply.aso": {
        source: "iana",
        extensions: ["aso"]
      },
      "application/vnd.accpac.simply.imp": {
        source: "iana",
        extensions: ["imp"]
      },
      "application/vnd.acucobol": {
        source: "iana",
        extensions: ["acu"]
      },
      "application/vnd.acucorp": {
        source: "iana",
        extensions: ["atc", "acutc"]
      },
      "application/vnd.adobe.air-application-installer-package+zip": {
        source: "apache",
        compressible: false,
        extensions: ["air"]
      },
      "application/vnd.adobe.flash.movie": {
        source: "iana"
      },
      "application/vnd.adobe.formscentral.fcdt": {
        source: "iana",
        extensions: ["fcdt"]
      },
      "application/vnd.adobe.fxp": {
        source: "iana",
        extensions: ["fxp", "fxpl"]
      },
      "application/vnd.adobe.partial-upload": {
        source: "iana"
      },
      "application/vnd.adobe.xdp+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xdp"]
      },
      "application/vnd.adobe.xfdf": {
        source: "iana",
        extensions: ["xfdf"]
      },
      "application/vnd.aether.imp": {
        source: "iana"
      },
      "application/vnd.afpc.afplinedata": {
        source: "iana"
      },
      "application/vnd.afpc.afplinedata-pagedef": {
        source: "iana"
      },
      "application/vnd.afpc.cmoca-cmresource": {
        source: "iana"
      },
      "application/vnd.afpc.foca-charset": {
        source: "iana"
      },
      "application/vnd.afpc.foca-codedfont": {
        source: "iana"
      },
      "application/vnd.afpc.foca-codepage": {
        source: "iana"
      },
      "application/vnd.afpc.modca": {
        source: "iana"
      },
      "application/vnd.afpc.modca-cmtable": {
        source: "iana"
      },
      "application/vnd.afpc.modca-formdef": {
        source: "iana"
      },
      "application/vnd.afpc.modca-mediummap": {
        source: "iana"
      },
      "application/vnd.afpc.modca-objectcontainer": {
        source: "iana"
      },
      "application/vnd.afpc.modca-overlay": {
        source: "iana"
      },
      "application/vnd.afpc.modca-pagesegment": {
        source: "iana"
      },
      "application/vnd.age": {
        source: "iana",
        extensions: ["age"]
      },
      "application/vnd.ah-barcode": {
        source: "iana"
      },
      "application/vnd.ahead.space": {
        source: "iana",
        extensions: ["ahead"]
      },
      "application/vnd.airzip.filesecure.azf": {
        source: "iana",
        extensions: ["azf"]
      },
      "application/vnd.airzip.filesecure.azs": {
        source: "iana",
        extensions: ["azs"]
      },
      "application/vnd.amadeus+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.amazon.ebook": {
        source: "apache",
        extensions: ["azw"]
      },
      "application/vnd.amazon.mobi8-ebook": {
        source: "iana"
      },
      "application/vnd.americandynamics.acc": {
        source: "iana",
        extensions: ["acc"]
      },
      "application/vnd.amiga.ami": {
        source: "iana",
        extensions: ["ami"]
      },
      "application/vnd.amundsen.maze+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.android.ota": {
        source: "iana"
      },
      "application/vnd.android.package-archive": {
        source: "apache",
        compressible: false,
        extensions: ["apk"]
      },
      "application/vnd.anki": {
        source: "iana"
      },
      "application/vnd.anser-web-certificate-issue-initiation": {
        source: "iana",
        extensions: ["cii"]
      },
      "application/vnd.anser-web-funds-transfer-initiation": {
        source: "apache",
        extensions: ["fti"]
      },
      "application/vnd.antix.game-component": {
        source: "iana",
        extensions: ["atx"]
      },
      "application/vnd.apache.arrow.file": {
        source: "iana"
      },
      "application/vnd.apache.arrow.stream": {
        source: "iana"
      },
      "application/vnd.apache.thrift.binary": {
        source: "iana"
      },
      "application/vnd.apache.thrift.compact": {
        source: "iana"
      },
      "application/vnd.apache.thrift.json": {
        source: "iana"
      },
      "application/vnd.api+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.aplextor.warrp+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.apothekende.reservation+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.apple.installer+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mpkg"]
      },
      "application/vnd.apple.keynote": {
        source: "iana",
        extensions: ["key"]
      },
      "application/vnd.apple.mpegurl": {
        source: "iana",
        extensions: ["m3u8"]
      },
      "application/vnd.apple.numbers": {
        source: "iana",
        extensions: ["numbers"]
      },
      "application/vnd.apple.pages": {
        source: "iana",
        extensions: ["pages"]
      },
      "application/vnd.apple.pkpass": {
        compressible: false,
        extensions: ["pkpass"]
      },
      "application/vnd.arastra.swi": {
        source: "iana"
      },
      "application/vnd.aristanetworks.swi": {
        source: "iana",
        extensions: ["swi"]
      },
      "application/vnd.artisan+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.artsquare": {
        source: "iana"
      },
      "application/vnd.astraea-software.iota": {
        source: "iana",
        extensions: ["iota"]
      },
      "application/vnd.audiograph": {
        source: "iana",
        extensions: ["aep"]
      },
      "application/vnd.autopackage": {
        source: "iana"
      },
      "application/vnd.avalon+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.avistar+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.balsamiq.bmml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["bmml"]
      },
      "application/vnd.balsamiq.bmpr": {
        source: "iana"
      },
      "application/vnd.banana-accounting": {
        source: "iana"
      },
      "application/vnd.bbf.usp.error": {
        source: "iana"
      },
      "application/vnd.bbf.usp.msg": {
        source: "iana"
      },
      "application/vnd.bbf.usp.msg+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.bekitzur-stech+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.bint.med-content": {
        source: "iana"
      },
      "application/vnd.biopax.rdf+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.blink-idb-value-wrapper": {
        source: "iana"
      },
      "application/vnd.blueice.multipass": {
        source: "iana",
        extensions: ["mpm"]
      },
      "application/vnd.bluetooth.ep.oob": {
        source: "iana"
      },
      "application/vnd.bluetooth.le.oob": {
        source: "iana"
      },
      "application/vnd.bmi": {
        source: "iana",
        extensions: ["bmi"]
      },
      "application/vnd.bpf": {
        source: "iana"
      },
      "application/vnd.bpf3": {
        source: "iana"
      },
      "application/vnd.businessobjects": {
        source: "iana",
        extensions: ["rep"]
      },
      "application/vnd.byu.uapi+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.cab-jscript": {
        source: "iana"
      },
      "application/vnd.canon-cpdl": {
        source: "iana"
      },
      "application/vnd.canon-lips": {
        source: "iana"
      },
      "application/vnd.capasystems-pg+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.cendio.thinlinc.clientconf": {
        source: "iana"
      },
      "application/vnd.century-systems.tcp_stream": {
        source: "iana"
      },
      "application/vnd.chemdraw+xml": {
        source: "iana",
        compressible: true,
        extensions: ["cdxml"]
      },
      "application/vnd.chess-pgn": {
        source: "iana"
      },
      "application/vnd.chipnuts.karaoke-mmd": {
        source: "iana",
        extensions: ["mmd"]
      },
      "application/vnd.ciedi": {
        source: "iana"
      },
      "application/vnd.cinderella": {
        source: "iana",
        extensions: ["cdy"]
      },
      "application/vnd.cirpack.isdn-ext": {
        source: "iana"
      },
      "application/vnd.citationstyles.style+xml": {
        source: "iana",
        compressible: true,
        extensions: ["csl"]
      },
      "application/vnd.claymore": {
        source: "iana",
        extensions: ["cla"]
      },
      "application/vnd.cloanto.rp9": {
        source: "iana",
        extensions: ["rp9"]
      },
      "application/vnd.clonk.c4group": {
        source: "iana",
        extensions: ["c4g", "c4d", "c4f", "c4p", "c4u"]
      },
      "application/vnd.cluetrust.cartomobile-config": {
        source: "iana",
        extensions: ["c11amc"]
      },
      "application/vnd.cluetrust.cartomobile-config-pkg": {
        source: "iana",
        extensions: ["c11amz"]
      },
      "application/vnd.coffeescript": {
        source: "iana"
      },
      "application/vnd.collabio.xodocuments.document": {
        source: "iana"
      },
      "application/vnd.collabio.xodocuments.document-template": {
        source: "iana"
      },
      "application/vnd.collabio.xodocuments.presentation": {
        source: "iana"
      },
      "application/vnd.collabio.xodocuments.presentation-template": {
        source: "iana"
      },
      "application/vnd.collabio.xodocuments.spreadsheet": {
        source: "iana"
      },
      "application/vnd.collabio.xodocuments.spreadsheet-template": {
        source: "iana"
      },
      "application/vnd.collection+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.collection.doc+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.collection.next+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.comicbook+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.comicbook-rar": {
        source: "iana"
      },
      "application/vnd.commerce-battelle": {
        source: "iana"
      },
      "application/vnd.commonspace": {
        source: "iana",
        extensions: ["csp"]
      },
      "application/vnd.contact.cmsg": {
        source: "iana",
        extensions: ["cdbcmsg"]
      },
      "application/vnd.coreos.ignition+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.cosmocaller": {
        source: "iana",
        extensions: ["cmc"]
      },
      "application/vnd.crick.clicker": {
        source: "iana",
        extensions: ["clkx"]
      },
      "application/vnd.crick.clicker.keyboard": {
        source: "iana",
        extensions: ["clkk"]
      },
      "application/vnd.crick.clicker.palette": {
        source: "iana",
        extensions: ["clkp"]
      },
      "application/vnd.crick.clicker.template": {
        source: "iana",
        extensions: ["clkt"]
      },
      "application/vnd.crick.clicker.wordbank": {
        source: "iana",
        extensions: ["clkw"]
      },
      "application/vnd.criticaltools.wbs+xml": {
        source: "iana",
        compressible: true,
        extensions: ["wbs"]
      },
      "application/vnd.cryptii.pipe+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.crypto-shade-file": {
        source: "iana"
      },
      "application/vnd.cryptomator.encrypted": {
        source: "iana"
      },
      "application/vnd.cryptomator.vault": {
        source: "iana"
      },
      "application/vnd.ctc-posml": {
        source: "iana",
        extensions: ["pml"]
      },
      "application/vnd.ctct.ws+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.cups-pdf": {
        source: "iana"
      },
      "application/vnd.cups-postscript": {
        source: "iana"
      },
      "application/vnd.cups-ppd": {
        source: "iana",
        extensions: ["ppd"]
      },
      "application/vnd.cups-raster": {
        source: "iana"
      },
      "application/vnd.cups-raw": {
        source: "iana"
      },
      "application/vnd.curl": {
        source: "iana"
      },
      "application/vnd.curl.car": {
        source: "apache",
        extensions: ["car"]
      },
      "application/vnd.curl.pcurl": {
        source: "apache",
        extensions: ["pcurl"]
      },
      "application/vnd.cyan.dean.root+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.cybank": {
        source: "iana"
      },
      "application/vnd.cyclonedx+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.cyclonedx+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.d2l.coursepackage1p0+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.d3m-dataset": {
        source: "iana"
      },
      "application/vnd.d3m-problem": {
        source: "iana"
      },
      "application/vnd.dart": {
        source: "iana",
        compressible: true,
        extensions: ["dart"]
      },
      "application/vnd.data-vision.rdz": {
        source: "iana",
        extensions: ["rdz"]
      },
      "application/vnd.datapackage+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dataresource+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dbf": {
        source: "iana",
        extensions: ["dbf"]
      },
      "application/vnd.debian.binary-package": {
        source: "iana"
      },
      "application/vnd.dece.data": {
        source: "iana",
        extensions: ["uvf", "uvvf", "uvd", "uvvd"]
      },
      "application/vnd.dece.ttml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["uvt", "uvvt"]
      },
      "application/vnd.dece.unspecified": {
        source: "iana",
        extensions: ["uvx", "uvvx"]
      },
      "application/vnd.dece.zip": {
        source: "iana",
        extensions: ["uvz", "uvvz"]
      },
      "application/vnd.denovo.fcselayout-link": {
        source: "iana",
        extensions: ["fe_launch"]
      },
      "application/vnd.desmume.movie": {
        source: "iana"
      },
      "application/vnd.dir-bi.plate-dl-nosuffix": {
        source: "iana"
      },
      "application/vnd.dm.delegation+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dna": {
        source: "iana",
        extensions: ["dna"]
      },
      "application/vnd.document+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dolby.mlp": {
        source: "apache",
        extensions: ["mlp"]
      },
      "application/vnd.dolby.mobile.1": {
        source: "iana"
      },
      "application/vnd.dolby.mobile.2": {
        source: "iana"
      },
      "application/vnd.doremir.scorecloud-binary-document": {
        source: "iana"
      },
      "application/vnd.dpgraph": {
        source: "iana",
        extensions: ["dpg"]
      },
      "application/vnd.dreamfactory": {
        source: "iana",
        extensions: ["dfac"]
      },
      "application/vnd.drive+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ds-keypoint": {
        source: "apache",
        extensions: ["kpxx"]
      },
      "application/vnd.dtg.local": {
        source: "iana"
      },
      "application/vnd.dtg.local.flash": {
        source: "iana"
      },
      "application/vnd.dtg.local.html": {
        source: "iana"
      },
      "application/vnd.dvb.ait": {
        source: "iana",
        extensions: ["ait"]
      },
      "application/vnd.dvb.dvbisl+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.dvbj": {
        source: "iana"
      },
      "application/vnd.dvb.esgcontainer": {
        source: "iana"
      },
      "application/vnd.dvb.ipdcdftnotifaccess": {
        source: "iana"
      },
      "application/vnd.dvb.ipdcesgaccess": {
        source: "iana"
      },
      "application/vnd.dvb.ipdcesgaccess2": {
        source: "iana"
      },
      "application/vnd.dvb.ipdcesgpdd": {
        source: "iana"
      },
      "application/vnd.dvb.ipdcroaming": {
        source: "iana"
      },
      "application/vnd.dvb.iptv.alfec-base": {
        source: "iana"
      },
      "application/vnd.dvb.iptv.alfec-enhancement": {
        source: "iana"
      },
      "application/vnd.dvb.notif-aggregate-root+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.notif-container+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.notif-generic+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.notif-ia-msglist+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.notif-ia-registration-request+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.notif-ia-registration-response+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.notif-init+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.dvb.pfr": {
        source: "iana"
      },
      "application/vnd.dvb.service": {
        source: "iana",
        extensions: ["svc"]
      },
      "application/vnd.dxr": {
        source: "iana"
      },
      "application/vnd.dynageo": {
        source: "iana",
        extensions: ["geo"]
      },
      "application/vnd.dzr": {
        source: "iana"
      },
      "application/vnd.easykaraoke.cdgdownload": {
        source: "iana"
      },
      "application/vnd.ecdis-update": {
        source: "iana"
      },
      "application/vnd.ecip.rlp": {
        source: "iana"
      },
      "application/vnd.eclipse.ditto+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ecowin.chart": {
        source: "iana",
        extensions: ["mag"]
      },
      "application/vnd.ecowin.filerequest": {
        source: "iana"
      },
      "application/vnd.ecowin.fileupdate": {
        source: "iana"
      },
      "application/vnd.ecowin.series": {
        source: "iana"
      },
      "application/vnd.ecowin.seriesrequest": {
        source: "iana"
      },
      "application/vnd.ecowin.seriesupdate": {
        source: "iana"
      },
      "application/vnd.efi.img": {
        source: "iana"
      },
      "application/vnd.efi.iso": {
        source: "iana"
      },
      "application/vnd.emclient.accessrequest+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.enliven": {
        source: "iana",
        extensions: ["nml"]
      },
      "application/vnd.enphase.envoy": {
        source: "iana"
      },
      "application/vnd.eprints.data+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.epson.esf": {
        source: "iana",
        extensions: ["esf"]
      },
      "application/vnd.epson.msf": {
        source: "iana",
        extensions: ["msf"]
      },
      "application/vnd.epson.quickanime": {
        source: "iana",
        extensions: ["qam"]
      },
      "application/vnd.epson.salt": {
        source: "iana",
        extensions: ["slt"]
      },
      "application/vnd.epson.ssf": {
        source: "iana",
        extensions: ["ssf"]
      },
      "application/vnd.ericsson.quickcall": {
        source: "iana"
      },
      "application/vnd.espass-espass+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.eszigno3+xml": {
        source: "iana",
        compressible: true,
        extensions: ["es3", "et3"]
      },
      "application/vnd.etsi.aoc+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.asic-e+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.etsi.asic-s+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.etsi.cug+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvcommand+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvdiscovery+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvprofile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvsad-bc+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvsad-cod+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvsad-npvr+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvservice+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvsync+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.iptvueprofile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.mcid+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.mheg5": {
        source: "iana"
      },
      "application/vnd.etsi.overload-control-policy-dataset+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.pstn+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.sci+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.simservs+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.timestamp-token": {
        source: "iana"
      },
      "application/vnd.etsi.tsl+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.etsi.tsl.der": {
        source: "iana"
      },
      "application/vnd.eu.kasparian.car+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.eudora.data": {
        source: "iana"
      },
      "application/vnd.evolv.ecig.profile": {
        source: "iana"
      },
      "application/vnd.evolv.ecig.settings": {
        source: "iana"
      },
      "application/vnd.evolv.ecig.theme": {
        source: "iana"
      },
      "application/vnd.exstream-empower+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.exstream-package": {
        source: "iana"
      },
      "application/vnd.ezpix-album": {
        source: "iana",
        extensions: ["ez2"]
      },
      "application/vnd.ezpix-package": {
        source: "iana",
        extensions: ["ez3"]
      },
      "application/vnd.f-secure.mobile": {
        source: "iana"
      },
      "application/vnd.familysearch.gedcom+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.fastcopy-disk-image": {
        source: "iana"
      },
      "application/vnd.fdf": {
        source: "iana",
        extensions: ["fdf"]
      },
      "application/vnd.fdsn.mseed": {
        source: "iana",
        extensions: ["mseed"]
      },
      "application/vnd.fdsn.seed": {
        source: "iana",
        extensions: ["seed", "dataless"]
      },
      "application/vnd.ffsns": {
        source: "iana"
      },
      "application/vnd.ficlab.flb+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.filmit.zfc": {
        source: "iana"
      },
      "application/vnd.fints": {
        source: "iana"
      },
      "application/vnd.firemonkeys.cloudcell": {
        source: "iana"
      },
      "application/vnd.flographit": {
        source: "iana",
        extensions: ["gph"]
      },
      "application/vnd.fluxtime.clip": {
        source: "iana",
        extensions: ["ftc"]
      },
      "application/vnd.font-fontforge-sfd": {
        source: "iana"
      },
      "application/vnd.framemaker": {
        source: "iana",
        extensions: ["fm", "frame", "maker", "book"]
      },
      "application/vnd.frogans.fnc": {
        source: "iana",
        extensions: ["fnc"]
      },
      "application/vnd.frogans.ltf": {
        source: "iana",
        extensions: ["ltf"]
      },
      "application/vnd.fsc.weblaunch": {
        source: "iana",
        extensions: ["fsc"]
      },
      "application/vnd.fujifilm.fb.docuworks": {
        source: "iana"
      },
      "application/vnd.fujifilm.fb.docuworks.binder": {
        source: "iana"
      },
      "application/vnd.fujifilm.fb.docuworks.container": {
        source: "iana"
      },
      "application/vnd.fujifilm.fb.jfi+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.fujitsu.oasys": {
        source: "iana",
        extensions: ["oas"]
      },
      "application/vnd.fujitsu.oasys2": {
        source: "iana",
        extensions: ["oa2"]
      },
      "application/vnd.fujitsu.oasys3": {
        source: "iana",
        extensions: ["oa3"]
      },
      "application/vnd.fujitsu.oasysgp": {
        source: "iana",
        extensions: ["fg5"]
      },
      "application/vnd.fujitsu.oasysprs": {
        source: "iana",
        extensions: ["bh2"]
      },
      "application/vnd.fujixerox.art-ex": {
        source: "iana"
      },
      "application/vnd.fujixerox.art4": {
        source: "iana"
      },
      "application/vnd.fujixerox.ddd": {
        source: "iana",
        extensions: ["ddd"]
      },
      "application/vnd.fujixerox.docuworks": {
        source: "iana",
        extensions: ["xdw"]
      },
      "application/vnd.fujixerox.docuworks.binder": {
        source: "iana",
        extensions: ["xbd"]
      },
      "application/vnd.fujixerox.docuworks.container": {
        source: "iana"
      },
      "application/vnd.fujixerox.hbpl": {
        source: "iana"
      },
      "application/vnd.fut-misnet": {
        source: "iana"
      },
      "application/vnd.futoin+cbor": {
        source: "iana"
      },
      "application/vnd.futoin+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.fuzzysheet": {
        source: "iana",
        extensions: ["fzs"]
      },
      "application/vnd.genomatix.tuxedo": {
        source: "iana",
        extensions: ["txd"]
      },
      "application/vnd.gentics.grd+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.geo+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.geocube+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.geogebra.file": {
        source: "iana",
        extensions: ["ggb"]
      },
      "application/vnd.geogebra.slides": {
        source: "iana"
      },
      "application/vnd.geogebra.tool": {
        source: "iana",
        extensions: ["ggt"]
      },
      "application/vnd.geometry-explorer": {
        source: "iana",
        extensions: ["gex", "gre"]
      },
      "application/vnd.geonext": {
        source: "iana",
        extensions: ["gxt"]
      },
      "application/vnd.geoplan": {
        source: "iana",
        extensions: ["g2w"]
      },
      "application/vnd.geospace": {
        source: "iana",
        extensions: ["g3w"]
      },
      "application/vnd.gerber": {
        source: "iana"
      },
      "application/vnd.globalplatform.card-content-mgt": {
        source: "iana"
      },
      "application/vnd.globalplatform.card-content-mgt-response": {
        source: "iana"
      },
      "application/vnd.gmx": {
        source: "iana",
        extensions: ["gmx"]
      },
      "application/vnd.google-apps.document": {
        compressible: false,
        extensions: ["gdoc"]
      },
      "application/vnd.google-apps.presentation": {
        compressible: false,
        extensions: ["gslides"]
      },
      "application/vnd.google-apps.spreadsheet": {
        compressible: false,
        extensions: ["gsheet"]
      },
      "application/vnd.google-earth.kml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["kml"]
      },
      "application/vnd.google-earth.kmz": {
        source: "iana",
        compressible: false,
        extensions: ["kmz"]
      },
      "application/vnd.gov.sk.e-form+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.gov.sk.e-form+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.gov.sk.xmldatacontainer+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.grafeq": {
        source: "iana",
        extensions: ["gqf", "gqs"]
      },
      "application/vnd.gridmp": {
        source: "iana"
      },
      "application/vnd.groove-account": {
        source: "iana",
        extensions: ["gac"]
      },
      "application/vnd.groove-help": {
        source: "iana",
        extensions: ["ghf"]
      },
      "application/vnd.groove-identity-message": {
        source: "iana",
        extensions: ["gim"]
      },
      "application/vnd.groove-injector": {
        source: "iana",
        extensions: ["grv"]
      },
      "application/vnd.groove-tool-message": {
        source: "iana",
        extensions: ["gtm"]
      },
      "application/vnd.groove-tool-template": {
        source: "iana",
        extensions: ["tpl"]
      },
      "application/vnd.groove-vcard": {
        source: "iana",
        extensions: ["vcg"]
      },
      "application/vnd.hal+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.hal+xml": {
        source: "iana",
        compressible: true,
        extensions: ["hal"]
      },
      "application/vnd.handheld-entertainment+xml": {
        source: "iana",
        compressible: true,
        extensions: ["zmm"]
      },
      "application/vnd.hbci": {
        source: "iana",
        extensions: ["hbci"]
      },
      "application/vnd.hc+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.hcl-bireports": {
        source: "iana"
      },
      "application/vnd.hdt": {
        source: "iana"
      },
      "application/vnd.heroku+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.hhe.lesson-player": {
        source: "iana",
        extensions: ["les"]
      },
      "application/vnd.hl7cda+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/vnd.hl7v2+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/vnd.hp-hpgl": {
        source: "iana",
        extensions: ["hpgl"]
      },
      "application/vnd.hp-hpid": {
        source: "iana",
        extensions: ["hpid"]
      },
      "application/vnd.hp-hps": {
        source: "iana",
        extensions: ["hps"]
      },
      "application/vnd.hp-jlyt": {
        source: "iana",
        extensions: ["jlt"]
      },
      "application/vnd.hp-pcl": {
        source: "iana",
        extensions: ["pcl"]
      },
      "application/vnd.hp-pclxl": {
        source: "iana",
        extensions: ["pclxl"]
      },
      "application/vnd.httphone": {
        source: "iana"
      },
      "application/vnd.hydrostatix.sof-data": {
        source: "iana",
        extensions: ["sfd-hdstx"]
      },
      "application/vnd.hyper+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.hyper-item+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.hyperdrive+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.hzn-3d-crossword": {
        source: "iana"
      },
      "application/vnd.ibm.afplinedata": {
        source: "iana"
      },
      "application/vnd.ibm.electronic-media": {
        source: "iana"
      },
      "application/vnd.ibm.minipay": {
        source: "iana",
        extensions: ["mpy"]
      },
      "application/vnd.ibm.modcap": {
        source: "iana",
        extensions: ["afp", "listafp", "list3820"]
      },
      "application/vnd.ibm.rights-management": {
        source: "iana",
        extensions: ["irm"]
      },
      "application/vnd.ibm.secure-container": {
        source: "iana",
        extensions: ["sc"]
      },
      "application/vnd.iccprofile": {
        source: "iana",
        extensions: ["icc", "icm"]
      },
      "application/vnd.ieee.1905": {
        source: "iana"
      },
      "application/vnd.igloader": {
        source: "iana",
        extensions: ["igl"]
      },
      "application/vnd.imagemeter.folder+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.imagemeter.image+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.immervision-ivp": {
        source: "iana",
        extensions: ["ivp"]
      },
      "application/vnd.immervision-ivu": {
        source: "iana",
        extensions: ["ivu"]
      },
      "application/vnd.ims.imsccv1p1": {
        source: "iana"
      },
      "application/vnd.ims.imsccv1p2": {
        source: "iana"
      },
      "application/vnd.ims.imsccv1p3": {
        source: "iana"
      },
      "application/vnd.ims.lis.v2.result+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ims.lti.v2.toolconsumerprofile+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ims.lti.v2.toolproxy+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ims.lti.v2.toolproxy.id+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ims.lti.v2.toolsettings+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ims.lti.v2.toolsettings.simple+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.informedcontrol.rms+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.informix-visionary": {
        source: "iana"
      },
      "application/vnd.infotech.project": {
        source: "iana"
      },
      "application/vnd.infotech.project+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.innopath.wamp.notification": {
        source: "iana"
      },
      "application/vnd.insors.igm": {
        source: "iana",
        extensions: ["igm"]
      },
      "application/vnd.intercon.formnet": {
        source: "iana",
        extensions: ["xpw", "xpx"]
      },
      "application/vnd.intergeo": {
        source: "iana",
        extensions: ["i2g"]
      },
      "application/vnd.intertrust.digibox": {
        source: "iana"
      },
      "application/vnd.intertrust.nncp": {
        source: "iana"
      },
      "application/vnd.intu.qbo": {
        source: "iana",
        extensions: ["qbo"]
      },
      "application/vnd.intu.qfx": {
        source: "iana",
        extensions: ["qfx"]
      },
      "application/vnd.iptc.g2.catalogitem+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.iptc.g2.conceptitem+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.iptc.g2.knowledgeitem+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.iptc.g2.newsitem+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.iptc.g2.newsmessage+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.iptc.g2.packageitem+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.iptc.g2.planningitem+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ipunplugged.rcprofile": {
        source: "iana",
        extensions: ["rcprofile"]
      },
      "application/vnd.irepository.package+xml": {
        source: "iana",
        compressible: true,
        extensions: ["irp"]
      },
      "application/vnd.is-xpr": {
        source: "iana",
        extensions: ["xpr"]
      },
      "application/vnd.isac.fcs": {
        source: "iana",
        extensions: ["fcs"]
      },
      "application/vnd.iso11783-10+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.jam": {
        source: "iana",
        extensions: ["jam"]
      },
      "application/vnd.japannet-directory-service": {
        source: "iana"
      },
      "application/vnd.japannet-jpnstore-wakeup": {
        source: "iana"
      },
      "application/vnd.japannet-payment-wakeup": {
        source: "iana"
      },
      "application/vnd.japannet-registration": {
        source: "iana"
      },
      "application/vnd.japannet-registration-wakeup": {
        source: "iana"
      },
      "application/vnd.japannet-setstore-wakeup": {
        source: "iana"
      },
      "application/vnd.japannet-verification": {
        source: "iana"
      },
      "application/vnd.japannet-verification-wakeup": {
        source: "iana"
      },
      "application/vnd.jcp.javame.midlet-rms": {
        source: "iana",
        extensions: ["rms"]
      },
      "application/vnd.jisp": {
        source: "iana",
        extensions: ["jisp"]
      },
      "application/vnd.joost.joda-archive": {
        source: "iana",
        extensions: ["joda"]
      },
      "application/vnd.jsk.isdn-ngn": {
        source: "iana"
      },
      "application/vnd.kahootz": {
        source: "iana",
        extensions: ["ktz", "ktr"]
      },
      "application/vnd.kde.karbon": {
        source: "iana",
        extensions: ["karbon"]
      },
      "application/vnd.kde.kchart": {
        source: "iana",
        extensions: ["chrt"]
      },
      "application/vnd.kde.kformula": {
        source: "iana",
        extensions: ["kfo"]
      },
      "application/vnd.kde.kivio": {
        source: "iana",
        extensions: ["flw"]
      },
      "application/vnd.kde.kontour": {
        source: "iana",
        extensions: ["kon"]
      },
      "application/vnd.kde.kpresenter": {
        source: "iana",
        extensions: ["kpr", "kpt"]
      },
      "application/vnd.kde.kspread": {
        source: "iana",
        extensions: ["ksp"]
      },
      "application/vnd.kde.kword": {
        source: "iana",
        extensions: ["kwd", "kwt"]
      },
      "application/vnd.kenameaapp": {
        source: "iana",
        extensions: ["htke"]
      },
      "application/vnd.kidspiration": {
        source: "iana",
        extensions: ["kia"]
      },
      "application/vnd.kinar": {
        source: "iana",
        extensions: ["kne", "knp"]
      },
      "application/vnd.koan": {
        source: "iana",
        extensions: ["skp", "skd", "skt", "skm"]
      },
      "application/vnd.kodak-descriptor": {
        source: "iana",
        extensions: ["sse"]
      },
      "application/vnd.las": {
        source: "iana"
      },
      "application/vnd.las.las+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.las.las+xml": {
        source: "iana",
        compressible: true,
        extensions: ["lasxml"]
      },
      "application/vnd.laszip": {
        source: "iana"
      },
      "application/vnd.leap+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.liberty-request+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.llamagraphics.life-balance.desktop": {
        source: "iana",
        extensions: ["lbd"]
      },
      "application/vnd.llamagraphics.life-balance.exchange+xml": {
        source: "iana",
        compressible: true,
        extensions: ["lbe"]
      },
      "application/vnd.logipipe.circuit+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.loom": {
        source: "iana"
      },
      "application/vnd.lotus-1-2-3": {
        source: "iana",
        extensions: ["123"]
      },
      "application/vnd.lotus-approach": {
        source: "iana",
        extensions: ["apr"]
      },
      "application/vnd.lotus-freelance": {
        source: "iana",
        extensions: ["pre"]
      },
      "application/vnd.lotus-notes": {
        source: "iana",
        extensions: ["nsf"]
      },
      "application/vnd.lotus-organizer": {
        source: "iana",
        extensions: ["org"]
      },
      "application/vnd.lotus-screencam": {
        source: "iana",
        extensions: ["scm"]
      },
      "application/vnd.lotus-wordpro": {
        source: "iana",
        extensions: ["lwp"]
      },
      "application/vnd.macports.portpkg": {
        source: "iana",
        extensions: ["portpkg"]
      },
      "application/vnd.mapbox-vector-tile": {
        source: "iana",
        extensions: ["mvt"]
      },
      "application/vnd.marlin.drm.actiontoken+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.marlin.drm.conftoken+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.marlin.drm.license+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.marlin.drm.mdcf": {
        source: "iana"
      },
      "application/vnd.mason+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.maxar.archive.3tz+zip": {
        source: "iana",
        compressible: false
      },
      "application/vnd.maxmind.maxmind-db": {
        source: "iana"
      },
      "application/vnd.mcd": {
        source: "iana",
        extensions: ["mcd"]
      },
      "application/vnd.medcalcdata": {
        source: "iana",
        extensions: ["mc1"]
      },
      "application/vnd.mediastation.cdkey": {
        source: "iana",
        extensions: ["cdkey"]
      },
      "application/vnd.meridian-slingshot": {
        source: "iana"
      },
      "application/vnd.mfer": {
        source: "iana",
        extensions: ["mwf"]
      },
      "application/vnd.mfmp": {
        source: "iana",
        extensions: ["mfm"]
      },
      "application/vnd.micro+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.micrografx.flo": {
        source: "iana",
        extensions: ["flo"]
      },
      "application/vnd.micrografx.igx": {
        source: "iana",
        extensions: ["igx"]
      },
      "application/vnd.microsoft.portable-executable": {
        source: "iana"
      },
      "application/vnd.microsoft.windows.thumbnail-cache": {
        source: "iana"
      },
      "application/vnd.miele+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.mif": {
        source: "iana",
        extensions: ["mif"]
      },
      "application/vnd.minisoft-hp3000-save": {
        source: "iana"
      },
      "application/vnd.mitsubishi.misty-guard.trustweb": {
        source: "iana"
      },
      "application/vnd.mobius.daf": {
        source: "iana",
        extensions: ["daf"]
      },
      "application/vnd.mobius.dis": {
        source: "iana",
        extensions: ["dis"]
      },
      "application/vnd.mobius.mbk": {
        source: "iana",
        extensions: ["mbk"]
      },
      "application/vnd.mobius.mqy": {
        source: "iana",
        extensions: ["mqy"]
      },
      "application/vnd.mobius.msl": {
        source: "iana",
        extensions: ["msl"]
      },
      "application/vnd.mobius.plc": {
        source: "iana",
        extensions: ["plc"]
      },
      "application/vnd.mobius.txf": {
        source: "iana",
        extensions: ["txf"]
      },
      "application/vnd.mophun.application": {
        source: "iana",
        extensions: ["mpn"]
      },
      "application/vnd.mophun.certificate": {
        source: "iana",
        extensions: ["mpc"]
      },
      "application/vnd.motorola.flexsuite": {
        source: "iana"
      },
      "application/vnd.motorola.flexsuite.adsi": {
        source: "iana"
      },
      "application/vnd.motorola.flexsuite.fis": {
        source: "iana"
      },
      "application/vnd.motorola.flexsuite.gotap": {
        source: "iana"
      },
      "application/vnd.motorola.flexsuite.kmr": {
        source: "iana"
      },
      "application/vnd.motorola.flexsuite.ttc": {
        source: "iana"
      },
      "application/vnd.motorola.flexsuite.wem": {
        source: "iana"
      },
      "application/vnd.motorola.iprm": {
        source: "iana"
      },
      "application/vnd.mozilla.xul+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xul"]
      },
      "application/vnd.ms-3mfdocument": {
        source: "iana"
      },
      "application/vnd.ms-artgalry": {
        source: "iana",
        extensions: ["cil"]
      },
      "application/vnd.ms-asf": {
        source: "iana"
      },
      "application/vnd.ms-cab-compressed": {
        source: "iana",
        extensions: ["cab"]
      },
      "application/vnd.ms-color.iccprofile": {
        source: "apache"
      },
      "application/vnd.ms-excel": {
        source: "iana",
        compressible: false,
        extensions: ["xls", "xlm", "xla", "xlc", "xlt", "xlw"]
      },
      "application/vnd.ms-excel.addin.macroenabled.12": {
        source: "iana",
        extensions: ["xlam"]
      },
      "application/vnd.ms-excel.sheet.binary.macroenabled.12": {
        source: "iana",
        extensions: ["xlsb"]
      },
      "application/vnd.ms-excel.sheet.macroenabled.12": {
        source: "iana",
        extensions: ["xlsm"]
      },
      "application/vnd.ms-excel.template.macroenabled.12": {
        source: "iana",
        extensions: ["xltm"]
      },
      "application/vnd.ms-fontobject": {
        source: "iana",
        compressible: true,
        extensions: ["eot"]
      },
      "application/vnd.ms-htmlhelp": {
        source: "iana",
        extensions: ["chm"]
      },
      "application/vnd.ms-ims": {
        source: "iana",
        extensions: ["ims"]
      },
      "application/vnd.ms-lrm": {
        source: "iana",
        extensions: ["lrm"]
      },
      "application/vnd.ms-office.activex+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ms-officetheme": {
        source: "iana",
        extensions: ["thmx"]
      },
      "application/vnd.ms-opentype": {
        source: "apache",
        compressible: true
      },
      "application/vnd.ms-outlook": {
        compressible: false,
        extensions: ["msg"]
      },
      "application/vnd.ms-package.obfuscated-opentype": {
        source: "apache"
      },
      "application/vnd.ms-pki.seccat": {
        source: "apache",
        extensions: ["cat"]
      },
      "application/vnd.ms-pki.stl": {
        source: "apache",
        extensions: ["stl"]
      },
      "application/vnd.ms-playready.initiator+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ms-powerpoint": {
        source: "iana",
        compressible: false,
        extensions: ["ppt", "pps", "pot"]
      },
      "application/vnd.ms-powerpoint.addin.macroenabled.12": {
        source: "iana",
        extensions: ["ppam"]
      },
      "application/vnd.ms-powerpoint.presentation.macroenabled.12": {
        source: "iana",
        extensions: ["pptm"]
      },
      "application/vnd.ms-powerpoint.slide.macroenabled.12": {
        source: "iana",
        extensions: ["sldm"]
      },
      "application/vnd.ms-powerpoint.slideshow.macroenabled.12": {
        source: "iana",
        extensions: ["ppsm"]
      },
      "application/vnd.ms-powerpoint.template.macroenabled.12": {
        source: "iana",
        extensions: ["potm"]
      },
      "application/vnd.ms-printdevicecapabilities+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ms-printing.printticket+xml": {
        source: "apache",
        compressible: true
      },
      "application/vnd.ms-printschematicket+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ms-project": {
        source: "iana",
        extensions: ["mpp", "mpt"]
      },
      "application/vnd.ms-tnef": {
        source: "iana"
      },
      "application/vnd.ms-windows.devicepairing": {
        source: "iana"
      },
      "application/vnd.ms-windows.nwprinting.oob": {
        source: "iana"
      },
      "application/vnd.ms-windows.printerpairing": {
        source: "iana"
      },
      "application/vnd.ms-windows.wsd.oob": {
        source: "iana"
      },
      "application/vnd.ms-wmdrm.lic-chlg-req": {
        source: "iana"
      },
      "application/vnd.ms-wmdrm.lic-resp": {
        source: "iana"
      },
      "application/vnd.ms-wmdrm.meter-chlg-req": {
        source: "iana"
      },
      "application/vnd.ms-wmdrm.meter-resp": {
        source: "iana"
      },
      "application/vnd.ms-word.document.macroenabled.12": {
        source: "iana",
        extensions: ["docm"]
      },
      "application/vnd.ms-word.template.macroenabled.12": {
        source: "iana",
        extensions: ["dotm"]
      },
      "application/vnd.ms-works": {
        source: "iana",
        extensions: ["wps", "wks", "wcm", "wdb"]
      },
      "application/vnd.ms-wpl": {
        source: "iana",
        extensions: ["wpl"]
      },
      "application/vnd.ms-xpsdocument": {
        source: "iana",
        compressible: false,
        extensions: ["xps"]
      },
      "application/vnd.msa-disk-image": {
        source: "iana"
      },
      "application/vnd.mseq": {
        source: "iana",
        extensions: ["mseq"]
      },
      "application/vnd.msign": {
        source: "iana"
      },
      "application/vnd.multiad.creator": {
        source: "iana"
      },
      "application/vnd.multiad.creator.cif": {
        source: "iana"
      },
      "application/vnd.music-niff": {
        source: "iana"
      },
      "application/vnd.musician": {
        source: "iana",
        extensions: ["mus"]
      },
      "application/vnd.muvee.style": {
        source: "iana",
        extensions: ["msty"]
      },
      "application/vnd.mynfc": {
        source: "iana",
        extensions: ["taglet"]
      },
      "application/vnd.nacamar.ybrid+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.ncd.control": {
        source: "iana"
      },
      "application/vnd.ncd.reference": {
        source: "iana"
      },
      "application/vnd.nearst.inv+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.nebumind.line": {
        source: "iana"
      },
      "application/vnd.nervana": {
        source: "iana"
      },
      "application/vnd.netfpx": {
        source: "iana"
      },
      "application/vnd.neurolanguage.nlu": {
        source: "iana",
        extensions: ["nlu"]
      },
      "application/vnd.nimn": {
        source: "iana"
      },
      "application/vnd.nintendo.nitro.rom": {
        source: "iana"
      },
      "application/vnd.nintendo.snes.rom": {
        source: "iana"
      },
      "application/vnd.nitf": {
        source: "iana",
        extensions: ["ntf", "nitf"]
      },
      "application/vnd.noblenet-directory": {
        source: "iana",
        extensions: ["nnd"]
      },
      "application/vnd.noblenet-sealer": {
        source: "iana",
        extensions: ["nns"]
      },
      "application/vnd.noblenet-web": {
        source: "iana",
        extensions: ["nnw"]
      },
      "application/vnd.nokia.catalogs": {
        source: "iana"
      },
      "application/vnd.nokia.conml+wbxml": {
        source: "iana"
      },
      "application/vnd.nokia.conml+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.nokia.iptv.config+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.nokia.isds-radio-presets": {
        source: "iana"
      },
      "application/vnd.nokia.landmark+wbxml": {
        source: "iana"
      },
      "application/vnd.nokia.landmark+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.nokia.landmarkcollection+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.nokia.n-gage.ac+xml": {
        source: "iana",
        compressible: true,
        extensions: ["ac"]
      },
      "application/vnd.nokia.n-gage.data": {
        source: "iana",
        extensions: ["ngdat"]
      },
      "application/vnd.nokia.n-gage.symbian.install": {
        source: "iana",
        extensions: ["n-gage"]
      },
      "application/vnd.nokia.ncd": {
        source: "iana"
      },
      "application/vnd.nokia.pcd+wbxml": {
        source: "iana"
      },
      "application/vnd.nokia.pcd+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.nokia.radio-preset": {
        source: "iana",
        extensions: ["rpst"]
      },
      "application/vnd.nokia.radio-presets": {
        source: "iana",
        extensions: ["rpss"]
      },
      "application/vnd.novadigm.edm": {
        source: "iana",
        extensions: ["edm"]
      },
      "application/vnd.novadigm.edx": {
        source: "iana",
        extensions: ["edx"]
      },
      "application/vnd.novadigm.ext": {
        source: "iana",
        extensions: ["ext"]
      },
      "application/vnd.ntt-local.content-share": {
        source: "iana"
      },
      "application/vnd.ntt-local.file-transfer": {
        source: "iana"
      },
      "application/vnd.ntt-local.ogw_remote-access": {
        source: "iana"
      },
      "application/vnd.ntt-local.sip-ta_remote": {
        source: "iana"
      },
      "application/vnd.ntt-local.sip-ta_tcp_stream": {
        source: "iana"
      },
      "application/vnd.oasis.opendocument.chart": {
        source: "iana",
        extensions: ["odc"]
      },
      "application/vnd.oasis.opendocument.chart-template": {
        source: "iana",
        extensions: ["otc"]
      },
      "application/vnd.oasis.opendocument.database": {
        source: "iana",
        extensions: ["odb"]
      },
      "application/vnd.oasis.opendocument.formula": {
        source: "iana",
        extensions: ["odf"]
      },
      "application/vnd.oasis.opendocument.formula-template": {
        source: "iana",
        extensions: ["odft"]
      },
      "application/vnd.oasis.opendocument.graphics": {
        source: "iana",
        compressible: false,
        extensions: ["odg"]
      },
      "application/vnd.oasis.opendocument.graphics-template": {
        source: "iana",
        extensions: ["otg"]
      },
      "application/vnd.oasis.opendocument.image": {
        source: "iana",
        extensions: ["odi"]
      },
      "application/vnd.oasis.opendocument.image-template": {
        source: "iana",
        extensions: ["oti"]
      },
      "application/vnd.oasis.opendocument.presentation": {
        source: "iana",
        compressible: false,
        extensions: ["odp"]
      },
      "application/vnd.oasis.opendocument.presentation-template": {
        source: "iana",
        extensions: ["otp"]
      },
      "application/vnd.oasis.opendocument.spreadsheet": {
        source: "iana",
        compressible: false,
        extensions: ["ods"]
      },
      "application/vnd.oasis.opendocument.spreadsheet-template": {
        source: "iana",
        extensions: ["ots"]
      },
      "application/vnd.oasis.opendocument.text": {
        source: "iana",
        compressible: false,
        extensions: ["odt"]
      },
      "application/vnd.oasis.opendocument.text-master": {
        source: "iana",
        extensions: ["odm"]
      },
      "application/vnd.oasis.opendocument.text-template": {
        source: "iana",
        extensions: ["ott"]
      },
      "application/vnd.oasis.opendocument.text-web": {
        source: "iana",
        extensions: ["oth"]
      },
      "application/vnd.obn": {
        source: "iana"
      },
      "application/vnd.ocf+cbor": {
        source: "iana"
      },
      "application/vnd.oci.image.manifest.v1+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oftn.l10n+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.contentaccessdownload+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.contentaccessstreaming+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.cspg-hexbinary": {
        source: "iana"
      },
      "application/vnd.oipf.dae.svg+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.dae.xhtml+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.mippvcontrolmessage+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.pae.gem": {
        source: "iana"
      },
      "application/vnd.oipf.spdiscovery+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.spdlist+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.ueprofile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oipf.userprofile+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.olpc-sugar": {
        source: "iana",
        extensions: ["xo"]
      },
      "application/vnd.oma-scws-config": {
        source: "iana"
      },
      "application/vnd.oma-scws-http-request": {
        source: "iana"
      },
      "application/vnd.oma-scws-http-response": {
        source: "iana"
      },
      "application/vnd.oma.bcast.associated-procedure-parameter+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.drm-trigger+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.imd+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.ltkm": {
        source: "iana"
      },
      "application/vnd.oma.bcast.notification+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.provisioningtrigger": {
        source: "iana"
      },
      "application/vnd.oma.bcast.sgboot": {
        source: "iana"
      },
      "application/vnd.oma.bcast.sgdd+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.sgdu": {
        source: "iana"
      },
      "application/vnd.oma.bcast.simple-symbol-container": {
        source: "iana"
      },
      "application/vnd.oma.bcast.smartcard-trigger+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.sprov+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.bcast.stkm": {
        source: "iana"
      },
      "application/vnd.oma.cab-address-book+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.cab-feature-handler+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.cab-pcc+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.cab-subs-invite+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.cab-user-prefs+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.dcd": {
        source: "iana"
      },
      "application/vnd.oma.dcdc": {
        source: "iana"
      },
      "application/vnd.oma.dd2+xml": {
        source: "iana",
        compressible: true,
        extensions: ["dd2"]
      },
      "application/vnd.oma.drm.risd+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.group-usage-list+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.lwm2m+cbor": {
        source: "iana"
      },
      "application/vnd.oma.lwm2m+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.lwm2m+tlv": {
        source: "iana"
      },
      "application/vnd.oma.pal+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.poc.detailed-progress-report+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.poc.final-report+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.poc.groups+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.poc.invocation-descriptor+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.poc.optimized-progress-report+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.push": {
        source: "iana"
      },
      "application/vnd.oma.scidm.messages+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oma.xcap-directory+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.omads-email+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/vnd.omads-file+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/vnd.omads-folder+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/vnd.omaloc-supl-init": {
        source: "iana"
      },
      "application/vnd.onepager": {
        source: "iana"
      },
      "application/vnd.onepagertamp": {
        source: "iana"
      },
      "application/vnd.onepagertamx": {
        source: "iana"
      },
      "application/vnd.onepagertat": {
        source: "iana"
      },
      "application/vnd.onepagertatp": {
        source: "iana"
      },
      "application/vnd.onepagertatx": {
        source: "iana"
      },
      "application/vnd.openblox.game+xml": {
        source: "iana",
        compressible: true,
        extensions: ["obgx"]
      },
      "application/vnd.openblox.game-binary": {
        source: "iana"
      },
      "application/vnd.openeye.oeb": {
        source: "iana"
      },
      "application/vnd.openofficeorg.extension": {
        source: "apache",
        extensions: ["oxt"]
      },
      "application/vnd.openstreetmap.data+xml": {
        source: "iana",
        compressible: true,
        extensions: ["osm"]
      },
      "application/vnd.opentimestamps.ots": {
        source: "iana"
      },
      "application/vnd.openxmlformats-officedocument.custom-properties+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.customxmlproperties+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawing+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawingml.chart+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawingml.diagramcolors+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawingml.diagramdata+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawingml.diagramlayout+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.drawingml.diagramstyle+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.extended-properties+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.commentauthors+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.comments+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.handoutmaster+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.notesmaster+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.notesslide+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
        source: "iana",
        compressible: false,
        extensions: ["pptx"]
      },
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.presprops+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slide": {
        source: "iana",
        extensions: ["sldx"]
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slide+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slidelayout+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slidemaster+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow": {
        source: "iana",
        extensions: ["ppsx"]
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.slideupdateinfo+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.tablestyles+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.tags+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.template": {
        source: "iana",
        extensions: ["potx"]
      },
      "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.presentationml.viewprops+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.calcchain+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.externallink+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcachedefinition+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcacherecords+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.pivottable+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.querytable+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionheaders+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionlog+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedstrings+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
        source: "iana",
        compressible: false,
        extensions: ["xlsx"]
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetmetadata+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.tablesinglecells+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template": {
        source: "iana",
        extensions: ["xltx"]
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.usernames+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.volatiledependencies+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.theme+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.themeoverride+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.vmldrawing": {
        source: "iana"
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
        source: "iana",
        compressible: false,
        extensions: ["docx"]
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.fonttable+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template": {
        source: "iana",
        extensions: ["dotx"]
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.websettings+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-package.core-properties+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.openxmlformats-package.relationships+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oracle.resource+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.orange.indata": {
        source: "iana"
      },
      "application/vnd.osa.netdeploy": {
        source: "iana"
      },
      "application/vnd.osgeo.mapguide.package": {
        source: "iana",
        extensions: ["mgp"]
      },
      "application/vnd.osgi.bundle": {
        source: "iana"
      },
      "application/vnd.osgi.dp": {
        source: "iana",
        extensions: ["dp"]
      },
      "application/vnd.osgi.subsystem": {
        source: "iana",
        extensions: ["esa"]
      },
      "application/vnd.otps.ct-kip+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.oxli.countgraph": {
        source: "iana"
      },
      "application/vnd.pagerduty+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.palm": {
        source: "iana",
        extensions: ["pdb", "pqa", "oprc"]
      },
      "application/vnd.panoply": {
        source: "iana"
      },
      "application/vnd.paos.xml": {
        source: "iana"
      },
      "application/vnd.patentdive": {
        source: "iana"
      },
      "application/vnd.patientecommsdoc": {
        source: "iana"
      },
      "application/vnd.pawaafile": {
        source: "iana",
        extensions: ["paw"]
      },
      "application/vnd.pcos": {
        source: "iana"
      },
      "application/vnd.pg.format": {
        source: "iana",
        extensions: ["str"]
      },
      "application/vnd.pg.osasli": {
        source: "iana",
        extensions: ["ei6"]
      },
      "application/vnd.piaccess.application-licence": {
        source: "iana"
      },
      "application/vnd.picsel": {
        source: "iana",
        extensions: ["efif"]
      },
      "application/vnd.pmi.widget": {
        source: "iana",
        extensions: ["wg"]
      },
      "application/vnd.poc.group-advertisement+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.pocketlearn": {
        source: "iana",
        extensions: ["plf"]
      },
      "application/vnd.powerbuilder6": {
        source: "iana",
        extensions: ["pbd"]
      },
      "application/vnd.powerbuilder6-s": {
        source: "iana"
      },
      "application/vnd.powerbuilder7": {
        source: "iana"
      },
      "application/vnd.powerbuilder7-s": {
        source: "iana"
      },
      "application/vnd.powerbuilder75": {
        source: "iana"
      },
      "application/vnd.powerbuilder75-s": {
        source: "iana"
      },
      "application/vnd.preminet": {
        source: "iana"
      },
      "application/vnd.previewsystems.box": {
        source: "iana",
        extensions: ["box"]
      },
      "application/vnd.proteus.magazine": {
        source: "iana",
        extensions: ["mgz"]
      },
      "application/vnd.psfs": {
        source: "iana"
      },
      "application/vnd.publishare-delta-tree": {
        source: "iana",
        extensions: ["qps"]
      },
      "application/vnd.pvi.ptid1": {
        source: "iana",
        extensions: ["ptid"]
      },
      "application/vnd.pwg-multiplexed": {
        source: "iana"
      },
      "application/vnd.pwg-xhtml-print+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.qualcomm.brew-app-res": {
        source: "iana"
      },
      "application/vnd.quarantainenet": {
        source: "iana"
      },
      "application/vnd.quark.quarkxpress": {
        source: "iana",
        extensions: ["qxd", "qxt", "qwd", "qwt", "qxl", "qxb"]
      },
      "application/vnd.quobject-quoxdocument": {
        source: "iana"
      },
      "application/vnd.radisys.moml+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-audit+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-audit-conf+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-audit-conn+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-audit-dialog+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-audit-stream+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-conf+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog-base+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog-fax-detect+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog-fax-sendrecv+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog-group+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog-speech+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.radisys.msml-dialog-transform+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.rainstor.data": {
        source: "iana"
      },
      "application/vnd.rapid": {
        source: "iana"
      },
      "application/vnd.rar": {
        source: "iana",
        extensions: ["rar"]
      },
      "application/vnd.realvnc.bed": {
        source: "iana",
        extensions: ["bed"]
      },
      "application/vnd.recordare.musicxml": {
        source: "iana",
        extensions: ["mxl"]
      },
      "application/vnd.recordare.musicxml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["musicxml"]
      },
      "application/vnd.renlearn.rlprint": {
        source: "iana"
      },
      "application/vnd.resilient.logic": {
        source: "iana"
      },
      "application/vnd.restful+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.rig.cryptonote": {
        source: "iana",
        extensions: ["cryptonote"]
      },
      "application/vnd.rim.cod": {
        source: "apache",
        extensions: ["cod"]
      },
      "application/vnd.rn-realmedia": {
        source: "apache",
        extensions: ["rm"]
      },
      "application/vnd.rn-realmedia-vbr": {
        source: "apache",
        extensions: ["rmvb"]
      },
      "application/vnd.route66.link66+xml": {
        source: "iana",
        compressible: true,
        extensions: ["link66"]
      },
      "application/vnd.rs-274x": {
        source: "iana"
      },
      "application/vnd.ruckus.download": {
        source: "iana"
      },
      "application/vnd.s3sms": {
        source: "iana"
      },
      "application/vnd.sailingtracker.track": {
        source: "iana",
        extensions: ["st"]
      },
      "application/vnd.sar": {
        source: "iana"
      },
      "application/vnd.sbm.cid": {
        source: "iana"
      },
      "application/vnd.sbm.mid2": {
        source: "iana"
      },
      "application/vnd.scribus": {
        source: "iana"
      },
      "application/vnd.sealed.3df": {
        source: "iana"
      },
      "application/vnd.sealed.csf": {
        source: "iana"
      },
      "application/vnd.sealed.doc": {
        source: "iana"
      },
      "application/vnd.sealed.eml": {
        source: "iana"
      },
      "application/vnd.sealed.mht": {
        source: "iana"
      },
      "application/vnd.sealed.net": {
        source: "iana"
      },
      "application/vnd.sealed.ppt": {
        source: "iana"
      },
      "application/vnd.sealed.tiff": {
        source: "iana"
      },
      "application/vnd.sealed.xls": {
        source: "iana"
      },
      "application/vnd.sealedmedia.softseal.html": {
        source: "iana"
      },
      "application/vnd.sealedmedia.softseal.pdf": {
        source: "iana"
      },
      "application/vnd.seemail": {
        source: "iana",
        extensions: ["see"]
      },
      "application/vnd.seis+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.sema": {
        source: "iana",
        extensions: ["sema"]
      },
      "application/vnd.semd": {
        source: "iana",
        extensions: ["semd"]
      },
      "application/vnd.semf": {
        source: "iana",
        extensions: ["semf"]
      },
      "application/vnd.shade-save-file": {
        source: "iana"
      },
      "application/vnd.shana.informed.formdata": {
        source: "iana",
        extensions: ["ifm"]
      },
      "application/vnd.shana.informed.formtemplate": {
        source: "iana",
        extensions: ["itp"]
      },
      "application/vnd.shana.informed.interchange": {
        source: "iana",
        extensions: ["iif"]
      },
      "application/vnd.shana.informed.package": {
        source: "iana",
        extensions: ["ipk"]
      },
      "application/vnd.shootproof+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.shopkick+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.shp": {
        source: "iana"
      },
      "application/vnd.shx": {
        source: "iana"
      },
      "application/vnd.sigrok.session": {
        source: "iana"
      },
      "application/vnd.simtech-mindmapper": {
        source: "iana",
        extensions: ["twd", "twds"]
      },
      "application/vnd.siren+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.smaf": {
        source: "iana",
        extensions: ["mmf"]
      },
      "application/vnd.smart.notebook": {
        source: "iana"
      },
      "application/vnd.smart.teacher": {
        source: "iana",
        extensions: ["teacher"]
      },
      "application/vnd.snesdev-page-table": {
        source: "iana"
      },
      "application/vnd.software602.filler.form+xml": {
        source: "iana",
        compressible: true,
        extensions: ["fo"]
      },
      "application/vnd.software602.filler.form-xml-zip": {
        source: "iana"
      },
      "application/vnd.solent.sdkm+xml": {
        source: "iana",
        compressible: true,
        extensions: ["sdkm", "sdkd"]
      },
      "application/vnd.spotfire.dxp": {
        source: "iana",
        extensions: ["dxp"]
      },
      "application/vnd.spotfire.sfs": {
        source: "iana",
        extensions: ["sfs"]
      },
      "application/vnd.sqlite3": {
        source: "iana"
      },
      "application/vnd.sss-cod": {
        source: "iana"
      },
      "application/vnd.sss-dtf": {
        source: "iana"
      },
      "application/vnd.sss-ntf": {
        source: "iana"
      },
      "application/vnd.stardivision.calc": {
        source: "apache",
        extensions: ["sdc"]
      },
      "application/vnd.stardivision.draw": {
        source: "apache",
        extensions: ["sda"]
      },
      "application/vnd.stardivision.impress": {
        source: "apache",
        extensions: ["sdd"]
      },
      "application/vnd.stardivision.math": {
        source: "apache",
        extensions: ["smf"]
      },
      "application/vnd.stardivision.writer": {
        source: "apache",
        extensions: ["sdw", "vor"]
      },
      "application/vnd.stardivision.writer-global": {
        source: "apache",
        extensions: ["sgl"]
      },
      "application/vnd.stepmania.package": {
        source: "iana",
        extensions: ["smzip"]
      },
      "application/vnd.stepmania.stepchart": {
        source: "iana",
        extensions: ["sm"]
      },
      "application/vnd.street-stream": {
        source: "iana"
      },
      "application/vnd.sun.wadl+xml": {
        source: "iana",
        compressible: true,
        extensions: ["wadl"]
      },
      "application/vnd.sun.xml.calc": {
        source: "apache",
        extensions: ["sxc"]
      },
      "application/vnd.sun.xml.calc.template": {
        source: "apache",
        extensions: ["stc"]
      },
      "application/vnd.sun.xml.draw": {
        source: "apache",
        extensions: ["sxd"]
      },
      "application/vnd.sun.xml.draw.template": {
        source: "apache",
        extensions: ["std"]
      },
      "application/vnd.sun.xml.impress": {
        source: "apache",
        extensions: ["sxi"]
      },
      "application/vnd.sun.xml.impress.template": {
        source: "apache",
        extensions: ["sti"]
      },
      "application/vnd.sun.xml.math": {
        source: "apache",
        extensions: ["sxm"]
      },
      "application/vnd.sun.xml.writer": {
        source: "apache",
        extensions: ["sxw"]
      },
      "application/vnd.sun.xml.writer.global": {
        source: "apache",
        extensions: ["sxg"]
      },
      "application/vnd.sun.xml.writer.template": {
        source: "apache",
        extensions: ["stw"]
      },
      "application/vnd.sus-calendar": {
        source: "iana",
        extensions: ["sus", "susp"]
      },
      "application/vnd.svd": {
        source: "iana",
        extensions: ["svd"]
      },
      "application/vnd.swiftview-ics": {
        source: "iana"
      },
      "application/vnd.sycle+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.syft+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.symbian.install": {
        source: "apache",
        extensions: ["sis", "sisx"]
      },
      "application/vnd.syncml+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["xsm"]
      },
      "application/vnd.syncml.dm+wbxml": {
        source: "iana",
        charset: "UTF-8",
        extensions: ["bdm"]
      },
      "application/vnd.syncml.dm+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["xdm"]
      },
      "application/vnd.syncml.dm.notification": {
        source: "iana"
      },
      "application/vnd.syncml.dmddf+wbxml": {
        source: "iana"
      },
      "application/vnd.syncml.dmddf+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["ddf"]
      },
      "application/vnd.syncml.dmtnds+wbxml": {
        source: "iana"
      },
      "application/vnd.syncml.dmtnds+xml": {
        source: "iana",
        charset: "UTF-8",
        compressible: true
      },
      "application/vnd.syncml.ds.notification": {
        source: "iana"
      },
      "application/vnd.tableschema+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.tao.intent-module-archive": {
        source: "iana",
        extensions: ["tao"]
      },
      "application/vnd.tcpdump.pcap": {
        source: "iana",
        extensions: ["pcap", "cap", "dmp"]
      },
      "application/vnd.think-cell.ppttc+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.tmd.mediaflex.api+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.tml": {
        source: "iana"
      },
      "application/vnd.tmobile-livetv": {
        source: "iana",
        extensions: ["tmo"]
      },
      "application/vnd.tri.onesource": {
        source: "iana"
      },
      "application/vnd.trid.tpt": {
        source: "iana",
        extensions: ["tpt"]
      },
      "application/vnd.triscape.mxs": {
        source: "iana",
        extensions: ["mxs"]
      },
      "application/vnd.trueapp": {
        source: "iana",
        extensions: ["tra"]
      },
      "application/vnd.truedoc": {
        source: "iana"
      },
      "application/vnd.ubisoft.webplayer": {
        source: "iana"
      },
      "application/vnd.ufdl": {
        source: "iana",
        extensions: ["ufd", "ufdl"]
      },
      "application/vnd.uiq.theme": {
        source: "iana",
        extensions: ["utz"]
      },
      "application/vnd.umajin": {
        source: "iana",
        extensions: ["umj"]
      },
      "application/vnd.unity": {
        source: "iana",
        extensions: ["unityweb"]
      },
      "application/vnd.uoml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["uoml"]
      },
      "application/vnd.uplanet.alert": {
        source: "iana"
      },
      "application/vnd.uplanet.alert-wbxml": {
        source: "iana"
      },
      "application/vnd.uplanet.bearer-choice": {
        source: "iana"
      },
      "application/vnd.uplanet.bearer-choice-wbxml": {
        source: "iana"
      },
      "application/vnd.uplanet.cacheop": {
        source: "iana"
      },
      "application/vnd.uplanet.cacheop-wbxml": {
        source: "iana"
      },
      "application/vnd.uplanet.channel": {
        source: "iana"
      },
      "application/vnd.uplanet.channel-wbxml": {
        source: "iana"
      },
      "application/vnd.uplanet.list": {
        source: "iana"
      },
      "application/vnd.uplanet.list-wbxml": {
        source: "iana"
      },
      "application/vnd.uplanet.listcmd": {
        source: "iana"
      },
      "application/vnd.uplanet.listcmd-wbxml": {
        source: "iana"
      },
      "application/vnd.uplanet.signal": {
        source: "iana"
      },
      "application/vnd.uri-map": {
        source: "iana"
      },
      "application/vnd.valve.source.material": {
        source: "iana"
      },
      "application/vnd.vcx": {
        source: "iana",
        extensions: ["vcx"]
      },
      "application/vnd.vd-study": {
        source: "iana"
      },
      "application/vnd.vectorworks": {
        source: "iana"
      },
      "application/vnd.vel+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.verimatrix.vcas": {
        source: "iana"
      },
      "application/vnd.veritone.aion+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.veryant.thin": {
        source: "iana"
      },
      "application/vnd.ves.encrypted": {
        source: "iana"
      },
      "application/vnd.vidsoft.vidconference": {
        source: "iana"
      },
      "application/vnd.visio": {
        source: "iana",
        extensions: ["vsd", "vst", "vss", "vsw"]
      },
      "application/vnd.visionary": {
        source: "iana",
        extensions: ["vis"]
      },
      "application/vnd.vividence.scriptfile": {
        source: "iana"
      },
      "application/vnd.vsf": {
        source: "iana",
        extensions: ["vsf"]
      },
      "application/vnd.wap.sic": {
        source: "iana"
      },
      "application/vnd.wap.slc": {
        source: "iana"
      },
      "application/vnd.wap.wbxml": {
        source: "iana",
        charset: "UTF-8",
        extensions: ["wbxml"]
      },
      "application/vnd.wap.wmlc": {
        source: "iana",
        extensions: ["wmlc"]
      },
      "application/vnd.wap.wmlscriptc": {
        source: "iana",
        extensions: ["wmlsc"]
      },
      "application/vnd.webturbo": {
        source: "iana",
        extensions: ["wtb"]
      },
      "application/vnd.wfa.dpp": {
        source: "iana"
      },
      "application/vnd.wfa.p2p": {
        source: "iana"
      },
      "application/vnd.wfa.wsc": {
        source: "iana"
      },
      "application/vnd.windows.devicepairing": {
        source: "iana"
      },
      "application/vnd.wmc": {
        source: "iana"
      },
      "application/vnd.wmf.bootstrap": {
        source: "iana"
      },
      "application/vnd.wolfram.mathematica": {
        source: "iana"
      },
      "application/vnd.wolfram.mathematica.package": {
        source: "iana"
      },
      "application/vnd.wolfram.player": {
        source: "iana",
        extensions: ["nbp"]
      },
      "application/vnd.wordperfect": {
        source: "iana",
        extensions: ["wpd"]
      },
      "application/vnd.wqd": {
        source: "iana",
        extensions: ["wqd"]
      },
      "application/vnd.wrq-hp3000-labelled": {
        source: "iana"
      },
      "application/vnd.wt.stf": {
        source: "iana",
        extensions: ["stf"]
      },
      "application/vnd.wv.csp+wbxml": {
        source: "iana"
      },
      "application/vnd.wv.csp+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.wv.ssp+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.xacml+json": {
        source: "iana",
        compressible: true
      },
      "application/vnd.xara": {
        source: "iana",
        extensions: ["xar"]
      },
      "application/vnd.xfdl": {
        source: "iana",
        extensions: ["xfdl"]
      },
      "application/vnd.xfdl.webform": {
        source: "iana"
      },
      "application/vnd.xmi+xml": {
        source: "iana",
        compressible: true
      },
      "application/vnd.xmpie.cpkg": {
        source: "iana"
      },
      "application/vnd.xmpie.dpkg": {
        source: "iana"
      },
      "application/vnd.xmpie.plan": {
        source: "iana"
      },
      "application/vnd.xmpie.ppkg": {
        source: "iana"
      },
      "application/vnd.xmpie.xlim": {
        source: "iana"
      },
      "application/vnd.yamaha.hv-dic": {
        source: "iana",
        extensions: ["hvd"]
      },
      "application/vnd.yamaha.hv-script": {
        source: "iana",
        extensions: ["hvs"]
      },
      "application/vnd.yamaha.hv-voice": {
        source: "iana",
        extensions: ["hvp"]
      },
      "application/vnd.yamaha.openscoreformat": {
        source: "iana",
        extensions: ["osf"]
      },
      "application/vnd.yamaha.openscoreformat.osfpvg+xml": {
        source: "iana",
        compressible: true,
        extensions: ["osfpvg"]
      },
      "application/vnd.yamaha.remote-setup": {
        source: "iana"
      },
      "application/vnd.yamaha.smaf-audio": {
        source: "iana",
        extensions: ["saf"]
      },
      "application/vnd.yamaha.smaf-phrase": {
        source: "iana",
        extensions: ["spf"]
      },
      "application/vnd.yamaha.through-ngn": {
        source: "iana"
      },
      "application/vnd.yamaha.tunnel-udpencap": {
        source: "iana"
      },
      "application/vnd.yaoweme": {
        source: "iana"
      },
      "application/vnd.yellowriver-custom-menu": {
        source: "iana",
        extensions: ["cmp"]
      },
      "application/vnd.youtube.yt": {
        source: "iana"
      },
      "application/vnd.zul": {
        source: "iana",
        extensions: ["zir", "zirz"]
      },
      "application/vnd.zzazz.deck+xml": {
        source: "iana",
        compressible: true,
        extensions: ["zaz"]
      },
      "application/voicexml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["vxml"]
      },
      "application/voucher-cms+json": {
        source: "iana",
        compressible: true
      },
      "application/vq-rtcpxr": {
        source: "iana"
      },
      "application/wasm": {
        source: "iana",
        compressible: true,
        extensions: ["wasm"]
      },
      "application/watcherinfo+xml": {
        source: "iana",
        compressible: true,
        extensions: ["wif"]
      },
      "application/webpush-options+json": {
        source: "iana",
        compressible: true
      },
      "application/whoispp-query": {
        source: "iana"
      },
      "application/whoispp-response": {
        source: "iana"
      },
      "application/widget": {
        source: "iana",
        extensions: ["wgt"]
      },
      "application/winhlp": {
        source: "apache",
        extensions: ["hlp"]
      },
      "application/wita": {
        source: "iana"
      },
      "application/wordperfect5.1": {
        source: "iana"
      },
      "application/wsdl+xml": {
        source: "iana",
        compressible: true,
        extensions: ["wsdl"]
      },
      "application/wspolicy+xml": {
        source: "iana",
        compressible: true,
        extensions: ["wspolicy"]
      },
      "application/x-7z-compressed": {
        source: "apache",
        compressible: false,
        extensions: ["7z"]
      },
      "application/x-abiword": {
        source: "apache",
        extensions: ["abw"]
      },
      "application/x-ace-compressed": {
        source: "apache",
        extensions: ["ace"]
      },
      "application/x-amf": {
        source: "apache"
      },
      "application/x-apple-diskimage": {
        source: "apache",
        extensions: ["dmg"]
      },
      "application/x-arj": {
        compressible: false,
        extensions: ["arj"]
      },
      "application/x-authorware-bin": {
        source: "apache",
        extensions: ["aab", "x32", "u32", "vox"]
      },
      "application/x-authorware-map": {
        source: "apache",
        extensions: ["aam"]
      },
      "application/x-authorware-seg": {
        source: "apache",
        extensions: ["aas"]
      },
      "application/x-bcpio": {
        source: "apache",
        extensions: ["bcpio"]
      },
      "application/x-bdoc": {
        compressible: false,
        extensions: ["bdoc"]
      },
      "application/x-bittorrent": {
        source: "apache",
        extensions: ["torrent"]
      },
      "application/x-blorb": {
        source: "apache",
        extensions: ["blb", "blorb"]
      },
      "application/x-bzip": {
        source: "apache",
        compressible: false,
        extensions: ["bz"]
      },
      "application/x-bzip2": {
        source: "apache",
        compressible: false,
        extensions: ["bz2", "boz"]
      },
      "application/x-cbr": {
        source: "apache",
        extensions: ["cbr", "cba", "cbt", "cbz", "cb7"]
      },
      "application/x-cdlink": {
        source: "apache",
        extensions: ["vcd"]
      },
      "application/x-cfs-compressed": {
        source: "apache",
        extensions: ["cfs"]
      },
      "application/x-chat": {
        source: "apache",
        extensions: ["chat"]
      },
      "application/x-chess-pgn": {
        source: "apache",
        extensions: ["pgn"]
      },
      "application/x-chrome-extension": {
        extensions: ["crx"]
      },
      "application/x-cocoa": {
        source: "nginx",
        extensions: ["cco"]
      },
      "application/x-compress": {
        source: "apache"
      },
      "application/x-conference": {
        source: "apache",
        extensions: ["nsc"]
      },
      "application/x-cpio": {
        source: "apache",
        extensions: ["cpio"]
      },
      "application/x-csh": {
        source: "apache",
        extensions: ["csh"]
      },
      "application/x-deb": {
        compressible: false
      },
      "application/x-debian-package": {
        source: "apache",
        extensions: ["deb", "udeb"]
      },
      "application/x-dgc-compressed": {
        source: "apache",
        extensions: ["dgc"]
      },
      "application/x-director": {
        source: "apache",
        extensions: ["dir", "dcr", "dxr", "cst", "cct", "cxt", "w3d", "fgd", "swa"]
      },
      "application/x-doom": {
        source: "apache",
        extensions: ["wad"]
      },
      "application/x-dtbncx+xml": {
        source: "apache",
        compressible: true,
        extensions: ["ncx"]
      },
      "application/x-dtbook+xml": {
        source: "apache",
        compressible: true,
        extensions: ["dtb"]
      },
      "application/x-dtbresource+xml": {
        source: "apache",
        compressible: true,
        extensions: ["res"]
      },
      "application/x-dvi": {
        source: "apache",
        compressible: false,
        extensions: ["dvi"]
      },
      "application/x-envoy": {
        source: "apache",
        extensions: ["evy"]
      },
      "application/x-eva": {
        source: "apache",
        extensions: ["eva"]
      },
      "application/x-font-bdf": {
        source: "apache",
        extensions: ["bdf"]
      },
      "application/x-font-dos": {
        source: "apache"
      },
      "application/x-font-framemaker": {
        source: "apache"
      },
      "application/x-font-ghostscript": {
        source: "apache",
        extensions: ["gsf"]
      },
      "application/x-font-libgrx": {
        source: "apache"
      },
      "application/x-font-linux-psf": {
        source: "apache",
        extensions: ["psf"]
      },
      "application/x-font-pcf": {
        source: "apache",
        extensions: ["pcf"]
      },
      "application/x-font-snf": {
        source: "apache",
        extensions: ["snf"]
      },
      "application/x-font-speedo": {
        source: "apache"
      },
      "application/x-font-sunos-news": {
        source: "apache"
      },
      "application/x-font-type1": {
        source: "apache",
        extensions: ["pfa", "pfb", "pfm", "afm"]
      },
      "application/x-font-vfont": {
        source: "apache"
      },
      "application/x-freearc": {
        source: "apache",
        extensions: ["arc"]
      },
      "application/x-futuresplash": {
        source: "apache",
        extensions: ["spl"]
      },
      "application/x-gca-compressed": {
        source: "apache",
        extensions: ["gca"]
      },
      "application/x-glulx": {
        source: "apache",
        extensions: ["ulx"]
      },
      "application/x-gnumeric": {
        source: "apache",
        extensions: ["gnumeric"]
      },
      "application/x-gramps-xml": {
        source: "apache",
        extensions: ["gramps"]
      },
      "application/x-gtar": {
        source: "apache",
        extensions: ["gtar"]
      },
      "application/x-gzip": {
        source: "apache"
      },
      "application/x-hdf": {
        source: "apache",
        extensions: ["hdf"]
      },
      "application/x-httpd-php": {
        compressible: true,
        extensions: ["php"]
      },
      "application/x-install-instructions": {
        source: "apache",
        extensions: ["install"]
      },
      "application/x-iso9660-image": {
        source: "apache",
        extensions: ["iso"]
      },
      "application/x-iwork-keynote-sffkey": {
        extensions: ["key"]
      },
      "application/x-iwork-numbers-sffnumbers": {
        extensions: ["numbers"]
      },
      "application/x-iwork-pages-sffpages": {
        extensions: ["pages"]
      },
      "application/x-java-archive-diff": {
        source: "nginx",
        extensions: ["jardiff"]
      },
      "application/x-java-jnlp-file": {
        source: "apache",
        compressible: false,
        extensions: ["jnlp"]
      },
      "application/x-javascript": {
        compressible: true
      },
      "application/x-keepass2": {
        extensions: ["kdbx"]
      },
      "application/x-latex": {
        source: "apache",
        compressible: false,
        extensions: ["latex"]
      },
      "application/x-lua-bytecode": {
        extensions: ["luac"]
      },
      "application/x-lzh-compressed": {
        source: "apache",
        extensions: ["lzh", "lha"]
      },
      "application/x-makeself": {
        source: "nginx",
        extensions: ["run"]
      },
      "application/x-mie": {
        source: "apache",
        extensions: ["mie"]
      },
      "application/x-mobipocket-ebook": {
        source: "apache",
        extensions: ["prc", "mobi"]
      },
      "application/x-mpegurl": {
        compressible: false
      },
      "application/x-ms-application": {
        source: "apache",
        extensions: ["application"]
      },
      "application/x-ms-shortcut": {
        source: "apache",
        extensions: ["lnk"]
      },
      "application/x-ms-wmd": {
        source: "apache",
        extensions: ["wmd"]
      },
      "application/x-ms-wmz": {
        source: "apache",
        extensions: ["wmz"]
      },
      "application/x-ms-xbap": {
        source: "apache",
        extensions: ["xbap"]
      },
      "application/x-msaccess": {
        source: "apache",
        extensions: ["mdb"]
      },
      "application/x-msbinder": {
        source: "apache",
        extensions: ["obd"]
      },
      "application/x-mscardfile": {
        source: "apache",
        extensions: ["crd"]
      },
      "application/x-msclip": {
        source: "apache",
        extensions: ["clp"]
      },
      "application/x-msdos-program": {
        extensions: ["exe"]
      },
      "application/x-msdownload": {
        source: "apache",
        extensions: ["exe", "dll", "com", "bat", "msi"]
      },
      "application/x-msmediaview": {
        source: "apache",
        extensions: ["mvb", "m13", "m14"]
      },
      "application/x-msmetafile": {
        source: "apache",
        extensions: ["wmf", "wmz", "emf", "emz"]
      },
      "application/x-msmoney": {
        source: "apache",
        extensions: ["mny"]
      },
      "application/x-mspublisher": {
        source: "apache",
        extensions: ["pub"]
      },
      "application/x-msschedule": {
        source: "apache",
        extensions: ["scd"]
      },
      "application/x-msterminal": {
        source: "apache",
        extensions: ["trm"]
      },
      "application/x-mswrite": {
        source: "apache",
        extensions: ["wri"]
      },
      "application/x-netcdf": {
        source: "apache",
        extensions: ["nc", "cdf"]
      },
      "application/x-ns-proxy-autoconfig": {
        compressible: true,
        extensions: ["pac"]
      },
      "application/x-nzb": {
        source: "apache",
        extensions: ["nzb"]
      },
      "application/x-perl": {
        source: "nginx",
        extensions: ["pl", "pm"]
      },
      "application/x-pilot": {
        source: "nginx",
        extensions: ["prc", "pdb"]
      },
      "application/x-pkcs12": {
        source: "apache",
        compressible: false,
        extensions: ["p12", "pfx"]
      },
      "application/x-pkcs7-certificates": {
        source: "apache",
        extensions: ["p7b", "spc"]
      },
      "application/x-pkcs7-certreqresp": {
        source: "apache",
        extensions: ["p7r"]
      },
      "application/x-pki-message": {
        source: "iana"
      },
      "application/x-rar-compressed": {
        source: "apache",
        compressible: false,
        extensions: ["rar"]
      },
      "application/x-redhat-package-manager": {
        source: "nginx",
        extensions: ["rpm"]
      },
      "application/x-research-info-systems": {
        source: "apache",
        extensions: ["ris"]
      },
      "application/x-sea": {
        source: "nginx",
        extensions: ["sea"]
      },
      "application/x-sh": {
        source: "apache",
        compressible: true,
        extensions: ["sh"]
      },
      "application/x-shar": {
        source: "apache",
        extensions: ["shar"]
      },
      "application/x-shockwave-flash": {
        source: "apache",
        compressible: false,
        extensions: ["swf"]
      },
      "application/x-silverlight-app": {
        source: "apache",
        extensions: ["xap"]
      },
      "application/x-sql": {
        source: "apache",
        extensions: ["sql"]
      },
      "application/x-stuffit": {
        source: "apache",
        compressible: false,
        extensions: ["sit"]
      },
      "application/x-stuffitx": {
        source: "apache",
        extensions: ["sitx"]
      },
      "application/x-subrip": {
        source: "apache",
        extensions: ["srt"]
      },
      "application/x-sv4cpio": {
        source: "apache",
        extensions: ["sv4cpio"]
      },
      "application/x-sv4crc": {
        source: "apache",
        extensions: ["sv4crc"]
      },
      "application/x-t3vm-image": {
        source: "apache",
        extensions: ["t3"]
      },
      "application/x-tads": {
        source: "apache",
        extensions: ["gam"]
      },
      "application/x-tar": {
        source: "apache",
        compressible: true,
        extensions: ["tar"]
      },
      "application/x-tcl": {
        source: "apache",
        extensions: ["tcl", "tk"]
      },
      "application/x-tex": {
        source: "apache",
        extensions: ["tex"]
      },
      "application/x-tex-tfm": {
        source: "apache",
        extensions: ["tfm"]
      },
      "application/x-texinfo": {
        source: "apache",
        extensions: ["texinfo", "texi"]
      },
      "application/x-tgif": {
        source: "apache",
        extensions: ["obj"]
      },
      "application/x-ustar": {
        source: "apache",
        extensions: ["ustar"]
      },
      "application/x-virtualbox-hdd": {
        compressible: true,
        extensions: ["hdd"]
      },
      "application/x-virtualbox-ova": {
        compressible: true,
        extensions: ["ova"]
      },
      "application/x-virtualbox-ovf": {
        compressible: true,
        extensions: ["ovf"]
      },
      "application/x-virtualbox-vbox": {
        compressible: true,
        extensions: ["vbox"]
      },
      "application/x-virtualbox-vbox-extpack": {
        compressible: false,
        extensions: ["vbox-extpack"]
      },
      "application/x-virtualbox-vdi": {
        compressible: true,
        extensions: ["vdi"]
      },
      "application/x-virtualbox-vhd": {
        compressible: true,
        extensions: ["vhd"]
      },
      "application/x-virtualbox-vmdk": {
        compressible: true,
        extensions: ["vmdk"]
      },
      "application/x-wais-source": {
        source: "apache",
        extensions: ["src"]
      },
      "application/x-web-app-manifest+json": {
        compressible: true,
        extensions: ["webapp"]
      },
      "application/x-www-form-urlencoded": {
        source: "iana",
        compressible: true
      },
      "application/x-x509-ca-cert": {
        source: "iana",
        extensions: ["der", "crt", "pem"]
      },
      "application/x-x509-ca-ra-cert": {
        source: "iana"
      },
      "application/x-x509-next-ca-cert": {
        source: "iana"
      },
      "application/x-xfig": {
        source: "apache",
        extensions: ["fig"]
      },
      "application/x-xliff+xml": {
        source: "apache",
        compressible: true,
        extensions: ["xlf"]
      },
      "application/x-xpinstall": {
        source: "apache",
        compressible: false,
        extensions: ["xpi"]
      },
      "application/x-xz": {
        source: "apache",
        extensions: ["xz"]
      },
      "application/x-zmachine": {
        source: "apache",
        extensions: ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8"]
      },
      "application/x400-bp": {
        source: "iana"
      },
      "application/xacml+xml": {
        source: "iana",
        compressible: true
      },
      "application/xaml+xml": {
        source: "apache",
        compressible: true,
        extensions: ["xaml"]
      },
      "application/xcap-att+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xav"]
      },
      "application/xcap-caps+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xca"]
      },
      "application/xcap-diff+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xdf"]
      },
      "application/xcap-el+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xel"]
      },
      "application/xcap-error+xml": {
        source: "iana",
        compressible: true
      },
      "application/xcap-ns+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xns"]
      },
      "application/xcon-conference-info+xml": {
        source: "iana",
        compressible: true
      },
      "application/xcon-conference-info-diff+xml": {
        source: "iana",
        compressible: true
      },
      "application/xenc+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xenc"]
      },
      "application/xhtml+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xhtml", "xht"]
      },
      "application/xhtml-voice+xml": {
        source: "apache",
        compressible: true
      },
      "application/xliff+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xlf"]
      },
      "application/xml": {
        source: "iana",
        compressible: true,
        extensions: ["xml", "xsl", "xsd", "rng"]
      },
      "application/xml-dtd": {
        source: "iana",
        compressible: true,
        extensions: ["dtd"]
      },
      "application/xml-external-parsed-entity": {
        source: "iana"
      },
      "application/xml-patch+xml": {
        source: "iana",
        compressible: true
      },
      "application/xmpp+xml": {
        source: "iana",
        compressible: true
      },
      "application/xop+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xop"]
      },
      "application/xproc+xml": {
        source: "apache",
        compressible: true,
        extensions: ["xpl"]
      },
      "application/xslt+xml": {
        source: "iana",
        compressible: true,
        extensions: ["xsl", "xslt"]
      },
      "application/xspf+xml": {
        source: "apache",
        compressible: true,
        extensions: ["xspf"]
      },
      "application/xv+xml": {
        source: "iana",
        compressible: true,
        extensions: ["mxml", "xhvml", "xvml", "xvm"]
      },
      "application/yang": {
        source: "iana",
        extensions: ["yang"]
      },
      "application/yang-data+json": {
        source: "iana",
        compressible: true
      },
      "application/yang-data+xml": {
        source: "iana",
        compressible: true
      },
      "application/yang-patch+json": {
        source: "iana",
        compressible: true
      },
      "application/yang-patch+xml": {
        source: "iana",
        compressible: true
      },
      "application/yin+xml": {
        source: "iana",
        compressible: true,
        extensions: ["yin"]
      },
      "application/zip": {
        source: "iana",
        compressible: false,
        extensions: ["zip"]
      },
      "application/zlib": {
        source: "iana"
      },
      "application/zstd": {
        source: "iana"
      },
      "audio/1d-interleaved-parityfec": {
        source: "iana"
      },
      "audio/32kadpcm": {
        source: "iana"
      },
      "audio/3gpp": {
        source: "iana",
        compressible: false,
        extensions: ["3gpp"]
      },
      "audio/3gpp2": {
        source: "iana"
      },
      "audio/aac": {
        source: "iana"
      },
      "audio/ac3": {
        source: "iana"
      },
      "audio/adpcm": {
        source: "apache",
        extensions: ["adp"]
      },
      "audio/amr": {
        source: "iana",
        extensions: ["amr"]
      },
      "audio/amr-wb": {
        source: "iana"
      },
      "audio/amr-wb+": {
        source: "iana"
      },
      "audio/aptx": {
        source: "iana"
      },
      "audio/asc": {
        source: "iana"
      },
      "audio/atrac-advanced-lossless": {
        source: "iana"
      },
      "audio/atrac-x": {
        source: "iana"
      },
      "audio/atrac3": {
        source: "iana"
      },
      "audio/basic": {
        source: "iana",
        compressible: false,
        extensions: ["au", "snd"]
      },
      "audio/bv16": {
        source: "iana"
      },
      "audio/bv32": {
        source: "iana"
      },
      "audio/clearmode": {
        source: "iana"
      },
      "audio/cn": {
        source: "iana"
      },
      "audio/dat12": {
        source: "iana"
      },
      "audio/dls": {
        source: "iana"
      },
      "audio/dsr-es201108": {
        source: "iana"
      },
      "audio/dsr-es202050": {
        source: "iana"
      },
      "audio/dsr-es202211": {
        source: "iana"
      },
      "audio/dsr-es202212": {
        source: "iana"
      },
      "audio/dv": {
        source: "iana"
      },
      "audio/dvi4": {
        source: "iana"
      },
      "audio/eac3": {
        source: "iana"
      },
      "audio/encaprtp": {
        source: "iana"
      },
      "audio/evrc": {
        source: "iana"
      },
      "audio/evrc-qcp": {
        source: "iana"
      },
      "audio/evrc0": {
        source: "iana"
      },
      "audio/evrc1": {
        source: "iana"
      },
      "audio/evrcb": {
        source: "iana"
      },
      "audio/evrcb0": {
        source: "iana"
      },
      "audio/evrcb1": {
        source: "iana"
      },
      "audio/evrcnw": {
        source: "iana"
      },
      "audio/evrcnw0": {
        source: "iana"
      },
      "audio/evrcnw1": {
        source: "iana"
      },
      "audio/evrcwb": {
        source: "iana"
      },
      "audio/evrcwb0": {
        source: "iana"
      },
      "audio/evrcwb1": {
        source: "iana"
      },
      "audio/evs": {
        source: "iana"
      },
      "audio/flexfec": {
        source: "iana"
      },
      "audio/fwdred": {
        source: "iana"
      },
      "audio/g711-0": {
        source: "iana"
      },
      "audio/g719": {
        source: "iana"
      },
      "audio/g722": {
        source: "iana"
      },
      "audio/g7221": {
        source: "iana"
      },
      "audio/g723": {
        source: "iana"
      },
      "audio/g726-16": {
        source: "iana"
      },
      "audio/g726-24": {
        source: "iana"
      },
      "audio/g726-32": {
        source: "iana"
      },
      "audio/g726-40": {
        source: "iana"
      },
      "audio/g728": {
        source: "iana"
      },
      "audio/g729": {
        source: "iana"
      },
      "audio/g7291": {
        source: "iana"
      },
      "audio/g729d": {
        source: "iana"
      },
      "audio/g729e": {
        source: "iana"
      },
      "audio/gsm": {
        source: "iana"
      },
      "audio/gsm-efr": {
        source: "iana"
      },
      "audio/gsm-hr-08": {
        source: "iana"
      },
      "audio/ilbc": {
        source: "iana"
      },
      "audio/ip-mr_v2.5": {
        source: "iana"
      },
      "audio/isac": {
        source: "apache"
      },
      "audio/l16": {
        source: "iana"
      },
      "audio/l20": {
        source: "iana"
      },
      "audio/l24": {
        source: "iana",
        compressible: false
      },
      "audio/l8": {
        source: "iana"
      },
      "audio/lpc": {
        source: "iana"
      },
      "audio/melp": {
        source: "iana"
      },
      "audio/melp1200": {
        source: "iana"
      },
      "audio/melp2400": {
        source: "iana"
      },
      "audio/melp600": {
        source: "iana"
      },
      "audio/mhas": {
        source: "iana"
      },
      "audio/midi": {
        source: "apache",
        extensions: ["mid", "midi", "kar", "rmi"]
      },
      "audio/mobile-xmf": {
        source: "iana",
        extensions: ["mxmf"]
      },
      "audio/mp3": {
        compressible: false,
        extensions: ["mp3"]
      },
      "audio/mp4": {
        source: "iana",
        compressible: false,
        extensions: ["m4a", "mp4a"]
      },
      "audio/mp4a-latm": {
        source: "iana"
      },
      "audio/mpa": {
        source: "iana"
      },
      "audio/mpa-robust": {
        source: "iana"
      },
      "audio/mpeg": {
        source: "iana",
        compressible: false,
        extensions: ["mpga", "mp2", "mp2a", "mp3", "m2a", "m3a"]
      },
      "audio/mpeg4-generic": {
        source: "iana"
      },
      "audio/musepack": {
        source: "apache"
      },
      "audio/ogg": {
        source: "iana",
        compressible: false,
        extensions: ["oga", "ogg", "spx", "opus"]
      },
      "audio/opus": {
        source: "iana"
      },
      "audio/parityfec": {
        source: "iana"
      },
      "audio/pcma": {
        source: "iana"
      },
      "audio/pcma-wb": {
        source: "iana"
      },
      "audio/pcmu": {
        source: "iana"
      },
      "audio/pcmu-wb": {
        source: "iana"
      },
      "audio/prs.sid": {
        source: "iana"
      },
      "audio/qcelp": {
        source: "iana"
      },
      "audio/raptorfec": {
        source: "iana"
      },
      "audio/red": {
        source: "iana"
      },
      "audio/rtp-enc-aescm128": {
        source: "iana"
      },
      "audio/rtp-midi": {
        source: "iana"
      },
      "audio/rtploopback": {
        source: "iana"
      },
      "audio/rtx": {
        source: "iana"
      },
      "audio/s3m": {
        source: "apache",
        extensions: ["s3m"]
      },
      "audio/scip": {
        source: "iana"
      },
      "audio/silk": {
        source: "apache",
        extensions: ["sil"]
      },
      "audio/smv": {
        source: "iana"
      },
      "audio/smv-qcp": {
        source: "iana"
      },
      "audio/smv0": {
        source: "iana"
      },
      "audio/sofa": {
        source: "iana"
      },
      "audio/sp-midi": {
        source: "iana"
      },
      "audio/speex": {
        source: "iana"
      },
      "audio/t140c": {
        source: "iana"
      },
      "audio/t38": {
        source: "iana"
      },
      "audio/telephone-event": {
        source: "iana"
      },
      "audio/tetra_acelp": {
        source: "iana"
      },
      "audio/tetra_acelp_bb": {
        source: "iana"
      },
      "audio/tone": {
        source: "iana"
      },
      "audio/tsvcis": {
        source: "iana"
      },
      "audio/uemclip": {
        source: "iana"
      },
      "audio/ulpfec": {
        source: "iana"
      },
      "audio/usac": {
        source: "iana"
      },
      "audio/vdvi": {
        source: "iana"
      },
      "audio/vmr-wb": {
        source: "iana"
      },
      "audio/vnd.3gpp.iufp": {
        source: "iana"
      },
      "audio/vnd.4sb": {
        source: "iana"
      },
      "audio/vnd.audiokoz": {
        source: "iana"
      },
      "audio/vnd.celp": {
        source: "iana"
      },
      "audio/vnd.cisco.nse": {
        source: "iana"
      },
      "audio/vnd.cmles.radio-events": {
        source: "iana"
      },
      "audio/vnd.cns.anp1": {
        source: "iana"
      },
      "audio/vnd.cns.inf1": {
        source: "iana"
      },
      "audio/vnd.dece.audio": {
        source: "iana",
        extensions: ["uva", "uvva"]
      },
      "audio/vnd.digital-winds": {
        source: "iana",
        extensions: ["eol"]
      },
      "audio/vnd.dlna.adts": {
        source: "iana"
      },
      "audio/vnd.dolby.heaac.1": {
        source: "iana"
      },
      "audio/vnd.dolby.heaac.2": {
        source: "iana"
      },
      "audio/vnd.dolby.mlp": {
        source: "iana"
      },
      "audio/vnd.dolby.mps": {
        source: "iana"
      },
      "audio/vnd.dolby.pl2": {
        source: "iana"
      },
      "audio/vnd.dolby.pl2x": {
        source: "iana"
      },
      "audio/vnd.dolby.pl2z": {
        source: "iana"
      },
      "audio/vnd.dolby.pulse.1": {
        source: "iana"
      },
      "audio/vnd.dra": {
        source: "iana",
        extensions: ["dra"]
      },
      "audio/vnd.dts": {
        source: "iana",
        extensions: ["dts"]
      },
      "audio/vnd.dts.hd": {
        source: "iana",
        extensions: ["dtshd"]
      },
      "audio/vnd.dts.uhd": {
        source: "iana"
      },
      "audio/vnd.dvb.file": {
        source: "iana"
      },
      "audio/vnd.everad.plj": {
        source: "iana"
      },
      "audio/vnd.hns.audio": {
        source: "iana"
      },
      "audio/vnd.lucent.voice": {
        source: "iana",
        extensions: ["lvp"]
      },
      "audio/vnd.ms-playready.media.pya": {
        source: "iana",
        extensions: ["pya"]
      },
      "audio/vnd.nokia.mobile-xmf": {
        source: "iana"
      },
      "audio/vnd.nortel.vbk": {
        source: "iana"
      },
      "audio/vnd.nuera.ecelp4800": {
        source: "iana",
        extensions: ["ecelp4800"]
      },
      "audio/vnd.nuera.ecelp7470": {
        source: "iana",
        extensions: ["ecelp7470"]
      },
      "audio/vnd.nuera.ecelp9600": {
        source: "iana",
        extensions: ["ecelp9600"]
      },
      "audio/vnd.octel.sbc": {
        source: "iana"
      },
      "audio/vnd.presonus.multitrack": {
        source: "iana"
      },
      "audio/vnd.qcelp": {
        source: "iana"
      },
      "audio/vnd.rhetorex.32kadpcm": {
        source: "iana"
      },
      "audio/vnd.rip": {
        source: "iana",
        extensions: ["rip"]
      },
      "audio/vnd.rn-realaudio": {
        compressible: false
      },
      "audio/vnd.sealedmedia.softseal.mpeg": {
        source: "iana"
      },
      "audio/vnd.vmx.cvsd": {
        source: "iana"
      },
      "audio/vnd.wave": {
        compressible: false
      },
      "audio/vorbis": {
        source: "iana",
        compressible: false
      },
      "audio/vorbis-config": {
        source: "iana"
      },
      "audio/wav": {
        compressible: false,
        extensions: ["wav"]
      },
      "audio/wave": {
        compressible: false,
        extensions: ["wav"]
      },
      "audio/webm": {
        source: "apache",
        compressible: false,
        extensions: ["weba"]
      },
      "audio/x-aac": {
        source: "apache",
        compressible: false,
        extensions: ["aac"]
      },
      "audio/x-aiff": {
        source: "apache",
        extensions: ["aif", "aiff", "aifc"]
      },
      "audio/x-caf": {
        source: "apache",
        compressible: false,
        extensions: ["caf"]
      },
      "audio/x-flac": {
        source: "apache",
        extensions: ["flac"]
      },
      "audio/x-m4a": {
        source: "nginx",
        extensions: ["m4a"]
      },
      "audio/x-matroska": {
        source: "apache",
        extensions: ["mka"]
      },
      "audio/x-mpegurl": {
        source: "apache",
        extensions: ["m3u"]
      },
      "audio/x-ms-wax": {
        source: "apache",
        extensions: ["wax"]
      },
      "audio/x-ms-wma": {
        source: "apache",
        extensions: ["wma"]
      },
      "audio/x-pn-realaudio": {
        source: "apache",
        extensions: ["ram", "ra"]
      },
      "audio/x-pn-realaudio-plugin": {
        source: "apache",
        extensions: ["rmp"]
      },
      "audio/x-realaudio": {
        source: "nginx",
        extensions: ["ra"]
      },
      "audio/x-tta": {
        source: "apache"
      },
      "audio/x-wav": {
        source: "apache",
        extensions: ["wav"]
      },
      "audio/xm": {
        source: "apache",
        extensions: ["xm"]
      },
      "chemical/x-cdx": {
        source: "apache",
        extensions: ["cdx"]
      },
      "chemical/x-cif": {
        source: "apache",
        extensions: ["cif"]
      },
      "chemical/x-cmdf": {
        source: "apache",
        extensions: ["cmdf"]
      },
      "chemical/x-cml": {
        source: "apache",
        extensions: ["cml"]
      },
      "chemical/x-csml": {
        source: "apache",
        extensions: ["csml"]
      },
      "chemical/x-pdb": {
        source: "apache"
      },
      "chemical/x-xyz": {
        source: "apache",
        extensions: ["xyz"]
      },
      "font/collection": {
        source: "iana",
        extensions: ["ttc"]
      },
      "font/otf": {
        source: "iana",
        compressible: true,
        extensions: ["otf"]
      },
      "font/sfnt": {
        source: "iana"
      },
      "font/ttf": {
        source: "iana",
        compressible: true,
        extensions: ["ttf"]
      },
      "font/woff": {
        source: "iana",
        extensions: ["woff"]
      },
      "font/woff2": {
        source: "iana",
        extensions: ["woff2"]
      },
      "image/aces": {
        source: "iana",
        extensions: ["exr"]
      },
      "image/apng": {
        compressible: false,
        extensions: ["apng"]
      },
      "image/avci": {
        source: "iana",
        extensions: ["avci"]
      },
      "image/avcs": {
        source: "iana",
        extensions: ["avcs"]
      },
      "image/avif": {
        source: "iana",
        compressible: false,
        extensions: ["avif"]
      },
      "image/bmp": {
        source: "iana",
        compressible: true,
        extensions: ["bmp"]
      },
      "image/cgm": {
        source: "iana",
        extensions: ["cgm"]
      },
      "image/dicom-rle": {
        source: "iana",
        extensions: ["drle"]
      },
      "image/emf": {
        source: "iana",
        extensions: ["emf"]
      },
      "image/fits": {
        source: "iana",
        extensions: ["fits"]
      },
      "image/g3fax": {
        source: "iana",
        extensions: ["g3"]
      },
      "image/gif": {
        source: "iana",
        compressible: false,
        extensions: ["gif"]
      },
      "image/heic": {
        source: "iana",
        extensions: ["heic"]
      },
      "image/heic-sequence": {
        source: "iana",
        extensions: ["heics"]
      },
      "image/heif": {
        source: "iana",
        extensions: ["heif"]
      },
      "image/heif-sequence": {
        source: "iana",
        extensions: ["heifs"]
      },
      "image/hej2k": {
        source: "iana",
        extensions: ["hej2"]
      },
      "image/hsj2": {
        source: "iana",
        extensions: ["hsj2"]
      },
      "image/ief": {
        source: "iana",
        extensions: ["ief"]
      },
      "image/jls": {
        source: "iana",
        extensions: ["jls"]
      },
      "image/jp2": {
        source: "iana",
        compressible: false,
        extensions: ["jp2", "jpg2"]
      },
      "image/jpeg": {
        source: "iana",
        compressible: false,
        extensions: ["jpeg", "jpg", "jpe"]
      },
      "image/jph": {
        source: "iana",
        extensions: ["jph"]
      },
      "image/jphc": {
        source: "iana",
        extensions: ["jhc"]
      },
      "image/jpm": {
        source: "iana",
        compressible: false,
        extensions: ["jpm"]
      },
      "image/jpx": {
        source: "iana",
        compressible: false,
        extensions: ["jpx", "jpf"]
      },
      "image/jxr": {
        source: "iana",
        extensions: ["jxr"]
      },
      "image/jxra": {
        source: "iana",
        extensions: ["jxra"]
      },
      "image/jxrs": {
        source: "iana",
        extensions: ["jxrs"]
      },
      "image/jxs": {
        source: "iana",
        extensions: ["jxs"]
      },
      "image/jxsc": {
        source: "iana",
        extensions: ["jxsc"]
      },
      "image/jxsi": {
        source: "iana",
        extensions: ["jxsi"]
      },
      "image/jxss": {
        source: "iana",
        extensions: ["jxss"]
      },
      "image/ktx": {
        source: "iana",
        extensions: ["ktx"]
      },
      "image/ktx2": {
        source: "iana",
        extensions: ["ktx2"]
      },
      "image/naplps": {
        source: "iana"
      },
      "image/pjpeg": {
        compressible: false
      },
      "image/png": {
        source: "iana",
        compressible: false,
        extensions: ["png"]
      },
      "image/prs.btif": {
        source: "iana",
        extensions: ["btif"]
      },
      "image/prs.pti": {
        source: "iana",
        extensions: ["pti"]
      },
      "image/pwg-raster": {
        source: "iana"
      },
      "image/sgi": {
        source: "apache",
        extensions: ["sgi"]
      },
      "image/svg+xml": {
        source: "iana",
        compressible: true,
        extensions: ["svg", "svgz"]
      },
      "image/t38": {
        source: "iana",
        extensions: ["t38"]
      },
      "image/tiff": {
        source: "iana",
        compressible: false,
        extensions: ["tif", "tiff"]
      },
      "image/tiff-fx": {
        source: "iana",
        extensions: ["tfx"]
      },
      "image/vnd.adobe.photoshop": {
        source: "iana",
        compressible: true,
        extensions: ["psd"]
      },
      "image/vnd.airzip.accelerator.azv": {
        source: "iana",
        extensions: ["azv"]
      },
      "image/vnd.cns.inf2": {
        source: "iana"
      },
      "image/vnd.dece.graphic": {
        source: "iana",
        extensions: ["uvi", "uvvi", "uvg", "uvvg"]
      },
      "image/vnd.djvu": {
        source: "iana",
        extensions: ["djvu", "djv"]
      },
      "image/vnd.dvb.subtitle": {
        source: "iana",
        extensions: ["sub"]
      },
      "image/vnd.dwg": {
        source: "iana",
        extensions: ["dwg"]
      },
      "image/vnd.dxf": {
        source: "iana",
        extensions: ["dxf"]
      },
      "image/vnd.fastbidsheet": {
        source: "iana",
        extensions: ["fbs"]
      },
      "image/vnd.fpx": {
        source: "iana",
        extensions: ["fpx"]
      },
      "image/vnd.fst": {
        source: "iana",
        extensions: ["fst"]
      },
      "image/vnd.fujixerox.edmics-mmr": {
        source: "iana",
        extensions: ["mmr"]
      },
      "image/vnd.fujixerox.edmics-rlc": {
        source: "iana",
        extensions: ["rlc"]
      },
      "image/vnd.globalgraphics.pgb": {
        source: "iana"
      },
      "image/vnd.microsoft.icon": {
        source: "iana",
        compressible: true,
        extensions: ["ico"]
      },
      "image/vnd.mix": {
        source: "iana"
      },
      "image/vnd.mozilla.apng": {
        source: "iana"
      },
      "image/vnd.ms-dds": {
        compressible: true,
        extensions: ["dds"]
      },
      "image/vnd.ms-modi": {
        source: "iana",
        extensions: ["mdi"]
      },
      "image/vnd.ms-photo": {
        source: "apache",
        extensions: ["wdp"]
      },
      "image/vnd.net-fpx": {
        source: "iana",
        extensions: ["npx"]
      },
      "image/vnd.pco.b16": {
        source: "iana",
        extensions: ["b16"]
      },
      "image/vnd.radiance": {
        source: "iana"
      },
      "image/vnd.sealed.png": {
        source: "iana"
      },
      "image/vnd.sealedmedia.softseal.gif": {
        source: "iana"
      },
      "image/vnd.sealedmedia.softseal.jpg": {
        source: "iana"
      },
      "image/vnd.svf": {
        source: "iana"
      },
      "image/vnd.tencent.tap": {
        source: "iana",
        extensions: ["tap"]
      },
      "image/vnd.valve.source.texture": {
        source: "iana",
        extensions: ["vtf"]
      },
      "image/vnd.wap.wbmp": {
        source: "iana",
        extensions: ["wbmp"]
      },
      "image/vnd.xiff": {
        source: "iana",
        extensions: ["xif"]
      },
      "image/vnd.zbrush.pcx": {
        source: "iana",
        extensions: ["pcx"]
      },
      "image/webp": {
        source: "apache",
        extensions: ["webp"]
      },
      "image/wmf": {
        source: "iana",
        extensions: ["wmf"]
      },
      "image/x-3ds": {
        source: "apache",
        extensions: ["3ds"]
      },
      "image/x-cmu-raster": {
        source: "apache",
        extensions: ["ras"]
      },
      "image/x-cmx": {
        source: "apache",
        extensions: ["cmx"]
      },
      "image/x-freehand": {
        source: "apache",
        extensions: ["fh", "fhc", "fh4", "fh5", "fh7"]
      },
      "image/x-icon": {
        source: "apache",
        compressible: true,
        extensions: ["ico"]
      },
      "image/x-jng": {
        source: "nginx",
        extensions: ["jng"]
      },
      "image/x-mrsid-image": {
        source: "apache",
        extensions: ["sid"]
      },
      "image/x-ms-bmp": {
        source: "nginx",
        compressible: true,
        extensions: ["bmp"]
      },
      "image/x-pcx": {
        source: "apache",
        extensions: ["pcx"]
      },
      "image/x-pict": {
        source: "apache",
        extensions: ["pic", "pct"]
      },
      "image/x-portable-anymap": {
        source: "apache",
        extensions: ["pnm"]
      },
      "image/x-portable-bitmap": {
        source: "apache",
        extensions: ["pbm"]
      },
      "image/x-portable-graymap": {
        source: "apache",
        extensions: ["pgm"]
      },
      "image/x-portable-pixmap": {
        source: "apache",
        extensions: ["ppm"]
      },
      "image/x-rgb": {
        source: "apache",
        extensions: ["rgb"]
      },
      "image/x-tga": {
        source: "apache",
        extensions: ["tga"]
      },
      "image/x-xbitmap": {
        source: "apache",
        extensions: ["xbm"]
      },
      "image/x-xcf": {
        compressible: false
      },
      "image/x-xpixmap": {
        source: "apache",
        extensions: ["xpm"]
      },
      "image/x-xwindowdump": {
        source: "apache",
        extensions: ["xwd"]
      },
      "message/cpim": {
        source: "iana"
      },
      "message/delivery-status": {
        source: "iana"
      },
      "message/disposition-notification": {
        source: "iana",
        extensions: [
          "disposition-notification"
        ]
      },
      "message/external-body": {
        source: "iana"
      },
      "message/feedback-report": {
        source: "iana"
      },
      "message/global": {
        source: "iana",
        extensions: ["u8msg"]
      },
      "message/global-delivery-status": {
        source: "iana",
        extensions: ["u8dsn"]
      },
      "message/global-disposition-notification": {
        source: "iana",
        extensions: ["u8mdn"]
      },
      "message/global-headers": {
        source: "iana",
        extensions: ["u8hdr"]
      },
      "message/http": {
        source: "iana",
        compressible: false
      },
      "message/imdn+xml": {
        source: "iana",
        compressible: true
      },
      "message/news": {
        source: "iana"
      },
      "message/partial": {
        source: "iana",
        compressible: false
      },
      "message/rfc822": {
        source: "iana",
        compressible: true,
        extensions: ["eml", "mime"]
      },
      "message/s-http": {
        source: "iana"
      },
      "message/sip": {
        source: "iana"
      },
      "message/sipfrag": {
        source: "iana"
      },
      "message/tracking-status": {
        source: "iana"
      },
      "message/vnd.si.simp": {
        source: "iana"
      },
      "message/vnd.wfa.wsc": {
        source: "iana",
        extensions: ["wsc"]
      },
      "model/3mf": {
        source: "iana",
        extensions: ["3mf"]
      },
      "model/e57": {
        source: "iana"
      },
      "model/gltf+json": {
        source: "iana",
        compressible: true,
        extensions: ["gltf"]
      },
      "model/gltf-binary": {
        source: "iana",
        compressible: true,
        extensions: ["glb"]
      },
      "model/iges": {
        source: "iana",
        compressible: false,
        extensions: ["igs", "iges"]
      },
      "model/mesh": {
        source: "iana",
        compressible: false,
        extensions: ["msh", "mesh", "silo"]
      },
      "model/mtl": {
        source: "iana",
        extensions: ["mtl"]
      },
      "model/obj": {
        source: "iana",
        extensions: ["obj"]
      },
      "model/step": {
        source: "iana"
      },
      "model/step+xml": {
        source: "iana",
        compressible: true,
        extensions: ["stpx"]
      },
      "model/step+zip": {
        source: "iana",
        compressible: false,
        extensions: ["stpz"]
      },
      "model/step-xml+zip": {
        source: "iana",
        compressible: false,
        extensions: ["stpxz"]
      },
      "model/stl": {
        source: "iana",
        extensions: ["stl"]
      },
      "model/vnd.collada+xml": {
        source: "iana",
        compressible: true,
        extensions: ["dae"]
      },
      "model/vnd.dwf": {
        source: "iana",
        extensions: ["dwf"]
      },
      "model/vnd.flatland.3dml": {
        source: "iana"
      },
      "model/vnd.gdl": {
        source: "iana",
        extensions: ["gdl"]
      },
      "model/vnd.gs-gdl": {
        source: "apache"
      },
      "model/vnd.gs.gdl": {
        source: "iana"
      },
      "model/vnd.gtw": {
        source: "iana",
        extensions: ["gtw"]
      },
      "model/vnd.moml+xml": {
        source: "iana",
        compressible: true
      },
      "model/vnd.mts": {
        source: "iana",
        extensions: ["mts"]
      },
      "model/vnd.opengex": {
        source: "iana",
        extensions: ["ogex"]
      },
      "model/vnd.parasolid.transmit.binary": {
        source: "iana",
        extensions: ["x_b"]
      },
      "model/vnd.parasolid.transmit.text": {
        source: "iana",
        extensions: ["x_t"]
      },
      "model/vnd.pytha.pyox": {
        source: "iana"
      },
      "model/vnd.rosette.annotated-data-model": {
        source: "iana"
      },
      "model/vnd.sap.vds": {
        source: "iana",
        extensions: ["vds"]
      },
      "model/vnd.usdz+zip": {
        source: "iana",
        compressible: false,
        extensions: ["usdz"]
      },
      "model/vnd.valve.source.compiled-map": {
        source: "iana",
        extensions: ["bsp"]
      },
      "model/vnd.vtu": {
        source: "iana",
        extensions: ["vtu"]
      },
      "model/vrml": {
        source: "iana",
        compressible: false,
        extensions: ["wrl", "vrml"]
      },
      "model/x3d+binary": {
        source: "apache",
        compressible: false,
        extensions: ["x3db", "x3dbz"]
      },
      "model/x3d+fastinfoset": {
        source: "iana",
        extensions: ["x3db"]
      },
      "model/x3d+vrml": {
        source: "apache",
        compressible: false,
        extensions: ["x3dv", "x3dvz"]
      },
      "model/x3d+xml": {
        source: "iana",
        compressible: true,
        extensions: ["x3d", "x3dz"]
      },
      "model/x3d-vrml": {
        source: "iana",
        extensions: ["x3dv"]
      },
      "multipart/alternative": {
        source: "iana",
        compressible: false
      },
      "multipart/appledouble": {
        source: "iana"
      },
      "multipart/byteranges": {
        source: "iana"
      },
      "multipart/digest": {
        source: "iana"
      },
      "multipart/encrypted": {
        source: "iana",
        compressible: false
      },
      "multipart/form-data": {
        source: "iana",
        compressible: false
      },
      "multipart/header-set": {
        source: "iana"
      },
      "multipart/mixed": {
        source: "iana"
      },
      "multipart/multilingual": {
        source: "iana"
      },
      "multipart/parallel": {
        source: "iana"
      },
      "multipart/related": {
        source: "iana",
        compressible: false
      },
      "multipart/report": {
        source: "iana"
      },
      "multipart/signed": {
        source: "iana",
        compressible: false
      },
      "multipart/vnd.bint.med-plus": {
        source: "iana"
      },
      "multipart/voice-message": {
        source: "iana"
      },
      "multipart/x-mixed-replace": {
        source: "iana"
      },
      "text/1d-interleaved-parityfec": {
        source: "iana"
      },
      "text/cache-manifest": {
        source: "iana",
        compressible: true,
        extensions: ["appcache", "manifest"]
      },
      "text/calendar": {
        source: "iana",
        extensions: ["ics", "ifb"]
      },
      "text/calender": {
        compressible: true
      },
      "text/cmd": {
        compressible: true
      },
      "text/coffeescript": {
        extensions: ["coffee", "litcoffee"]
      },
      "text/cql": {
        source: "iana"
      },
      "text/cql-expression": {
        source: "iana"
      },
      "text/cql-identifier": {
        source: "iana"
      },
      "text/css": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["css"]
      },
      "text/csv": {
        source: "iana",
        compressible: true,
        extensions: ["csv"]
      },
      "text/csv-schema": {
        source: "iana"
      },
      "text/directory": {
        source: "iana"
      },
      "text/dns": {
        source: "iana"
      },
      "text/ecmascript": {
        source: "iana"
      },
      "text/encaprtp": {
        source: "iana"
      },
      "text/enriched": {
        source: "iana"
      },
      "text/fhirpath": {
        source: "iana"
      },
      "text/flexfec": {
        source: "iana"
      },
      "text/fwdred": {
        source: "iana"
      },
      "text/gff3": {
        source: "iana"
      },
      "text/grammar-ref-list": {
        source: "iana"
      },
      "text/html": {
        source: "iana",
        compressible: true,
        extensions: ["html", "htm", "shtml"]
      },
      "text/jade": {
        extensions: ["jade"]
      },
      "text/javascript": {
        source: "iana",
        compressible: true
      },
      "text/jcr-cnd": {
        source: "iana"
      },
      "text/jsx": {
        compressible: true,
        extensions: ["jsx"]
      },
      "text/less": {
        compressible: true,
        extensions: ["less"]
      },
      "text/markdown": {
        source: "iana",
        compressible: true,
        extensions: ["markdown", "md"]
      },
      "text/mathml": {
        source: "nginx",
        extensions: ["mml"]
      },
      "text/mdx": {
        compressible: true,
        extensions: ["mdx"]
      },
      "text/mizar": {
        source: "iana"
      },
      "text/n3": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["n3"]
      },
      "text/parameters": {
        source: "iana",
        charset: "UTF-8"
      },
      "text/parityfec": {
        source: "iana"
      },
      "text/plain": {
        source: "iana",
        compressible: true,
        extensions: ["txt", "text", "conf", "def", "list", "log", "in", "ini"]
      },
      "text/provenance-notation": {
        source: "iana",
        charset: "UTF-8"
      },
      "text/prs.fallenstein.rst": {
        source: "iana"
      },
      "text/prs.lines.tag": {
        source: "iana",
        extensions: ["dsc"]
      },
      "text/prs.prop.logic": {
        source: "iana"
      },
      "text/raptorfec": {
        source: "iana"
      },
      "text/red": {
        source: "iana"
      },
      "text/rfc822-headers": {
        source: "iana"
      },
      "text/richtext": {
        source: "iana",
        compressible: true,
        extensions: ["rtx"]
      },
      "text/rtf": {
        source: "iana",
        compressible: true,
        extensions: ["rtf"]
      },
      "text/rtp-enc-aescm128": {
        source: "iana"
      },
      "text/rtploopback": {
        source: "iana"
      },
      "text/rtx": {
        source: "iana"
      },
      "text/sgml": {
        source: "iana",
        extensions: ["sgml", "sgm"]
      },
      "text/shaclc": {
        source: "iana"
      },
      "text/shex": {
        source: "iana",
        extensions: ["shex"]
      },
      "text/slim": {
        extensions: ["slim", "slm"]
      },
      "text/spdx": {
        source: "iana",
        extensions: ["spdx"]
      },
      "text/strings": {
        source: "iana"
      },
      "text/stylus": {
        extensions: ["stylus", "styl"]
      },
      "text/t140": {
        source: "iana"
      },
      "text/tab-separated-values": {
        source: "iana",
        compressible: true,
        extensions: ["tsv"]
      },
      "text/troff": {
        source: "iana",
        extensions: ["t", "tr", "roff", "man", "me", "ms"]
      },
      "text/turtle": {
        source: "iana",
        charset: "UTF-8",
        extensions: ["ttl"]
      },
      "text/ulpfec": {
        source: "iana"
      },
      "text/uri-list": {
        source: "iana",
        compressible: true,
        extensions: ["uri", "uris", "urls"]
      },
      "text/vcard": {
        source: "iana",
        compressible: true,
        extensions: ["vcard"]
      },
      "text/vnd.a": {
        source: "iana"
      },
      "text/vnd.abc": {
        source: "iana"
      },
      "text/vnd.ascii-art": {
        source: "iana"
      },
      "text/vnd.curl": {
        source: "iana",
        extensions: ["curl"]
      },
      "text/vnd.curl.dcurl": {
        source: "apache",
        extensions: ["dcurl"]
      },
      "text/vnd.curl.mcurl": {
        source: "apache",
        extensions: ["mcurl"]
      },
      "text/vnd.curl.scurl": {
        source: "apache",
        extensions: ["scurl"]
      },
      "text/vnd.debian.copyright": {
        source: "iana",
        charset: "UTF-8"
      },
      "text/vnd.dmclientscript": {
        source: "iana"
      },
      "text/vnd.dvb.subtitle": {
        source: "iana",
        extensions: ["sub"]
      },
      "text/vnd.esmertec.theme-descriptor": {
        source: "iana",
        charset: "UTF-8"
      },
      "text/vnd.familysearch.gedcom": {
        source: "iana",
        extensions: ["ged"]
      },
      "text/vnd.ficlab.flt": {
        source: "iana"
      },
      "text/vnd.fly": {
        source: "iana",
        extensions: ["fly"]
      },
      "text/vnd.fmi.flexstor": {
        source: "iana",
        extensions: ["flx"]
      },
      "text/vnd.gml": {
        source: "iana"
      },
      "text/vnd.graphviz": {
        source: "iana",
        extensions: ["gv"]
      },
      "text/vnd.hans": {
        source: "iana"
      },
      "text/vnd.hgl": {
        source: "iana"
      },
      "text/vnd.in3d.3dml": {
        source: "iana",
        extensions: ["3dml"]
      },
      "text/vnd.in3d.spot": {
        source: "iana",
        extensions: ["spot"]
      },
      "text/vnd.iptc.newsml": {
        source: "iana"
      },
      "text/vnd.iptc.nitf": {
        source: "iana"
      },
      "text/vnd.latex-z": {
        source: "iana"
      },
      "text/vnd.motorola.reflex": {
        source: "iana"
      },
      "text/vnd.ms-mediapackage": {
        source: "iana"
      },
      "text/vnd.net2phone.commcenter.command": {
        source: "iana"
      },
      "text/vnd.radisys.msml-basic-layout": {
        source: "iana"
      },
      "text/vnd.senx.warpscript": {
        source: "iana"
      },
      "text/vnd.si.uricatalogue": {
        source: "iana"
      },
      "text/vnd.sosi": {
        source: "iana"
      },
      "text/vnd.sun.j2me.app-descriptor": {
        source: "iana",
        charset: "UTF-8",
        extensions: ["jad"]
      },
      "text/vnd.trolltech.linguist": {
        source: "iana",
        charset: "UTF-8"
      },
      "text/vnd.wap.si": {
        source: "iana"
      },
      "text/vnd.wap.sl": {
        source: "iana"
      },
      "text/vnd.wap.wml": {
        source: "iana",
        extensions: ["wml"]
      },
      "text/vnd.wap.wmlscript": {
        source: "iana",
        extensions: ["wmls"]
      },
      "text/vtt": {
        source: "iana",
        charset: "UTF-8",
        compressible: true,
        extensions: ["vtt"]
      },
      "text/x-asm": {
        source: "apache",
        extensions: ["s", "asm"]
      },
      "text/x-c": {
        source: "apache",
        extensions: ["c", "cc", "cxx", "cpp", "h", "hh", "dic"]
      },
      "text/x-component": {
        source: "nginx",
        extensions: ["htc"]
      },
      "text/x-fortran": {
        source: "apache",
        extensions: ["f", "for", "f77", "f90"]
      },
      "text/x-gwt-rpc": {
        compressible: true
      },
      "text/x-handlebars-template": {
        extensions: ["hbs"]
      },
      "text/x-java-source": {
        source: "apache",
        extensions: ["java"]
      },
      "text/x-jquery-tmpl": {
        compressible: true
      },
      "text/x-lua": {
        extensions: ["lua"]
      },
      "text/x-markdown": {
        compressible: true,
        extensions: ["mkd"]
      },
      "text/x-nfo": {
        source: "apache",
        extensions: ["nfo"]
      },
      "text/x-opml": {
        source: "apache",
        extensions: ["opml"]
      },
      "text/x-org": {
        compressible: true,
        extensions: ["org"]
      },
      "text/x-pascal": {
        source: "apache",
        extensions: ["p", "pas"]
      },
      "text/x-processing": {
        compressible: true,
        extensions: ["pde"]
      },
      "text/x-sass": {
        extensions: ["sass"]
      },
      "text/x-scss": {
        extensions: ["scss"]
      },
      "text/x-setext": {
        source: "apache",
        extensions: ["etx"]
      },
      "text/x-sfv": {
        source: "apache",
        extensions: ["sfv"]
      },
      "text/x-suse-ymp": {
        compressible: true,
        extensions: ["ymp"]
      },
      "text/x-uuencode": {
        source: "apache",
        extensions: ["uu"]
      },
      "text/x-vcalendar": {
        source: "apache",
        extensions: ["vcs"]
      },
      "text/x-vcard": {
        source: "apache",
        extensions: ["vcf"]
      },
      "text/xml": {
        source: "iana",
        compressible: true,
        extensions: ["xml"]
      },
      "text/xml-external-parsed-entity": {
        source: "iana"
      },
      "text/yaml": {
        compressible: true,
        extensions: ["yaml", "yml"]
      },
      "video/1d-interleaved-parityfec": {
        source: "iana"
      },
      "video/3gpp": {
        source: "iana",
        extensions: ["3gp", "3gpp"]
      },
      "video/3gpp-tt": {
        source: "iana"
      },
      "video/3gpp2": {
        source: "iana",
        extensions: ["3g2"]
      },
      "video/av1": {
        source: "iana"
      },
      "video/bmpeg": {
        source: "iana"
      },
      "video/bt656": {
        source: "iana"
      },
      "video/celb": {
        source: "iana"
      },
      "video/dv": {
        source: "iana"
      },
      "video/encaprtp": {
        source: "iana"
      },
      "video/ffv1": {
        source: "iana"
      },
      "video/flexfec": {
        source: "iana"
      },
      "video/h261": {
        source: "iana",
        extensions: ["h261"]
      },
      "video/h263": {
        source: "iana",
        extensions: ["h263"]
      },
      "video/h263-1998": {
        source: "iana"
      },
      "video/h263-2000": {
        source: "iana"
      },
      "video/h264": {
        source: "iana",
        extensions: ["h264"]
      },
      "video/h264-rcdo": {
        source: "iana"
      },
      "video/h264-svc": {
        source: "iana"
      },
      "video/h265": {
        source: "iana"
      },
      "video/iso.segment": {
        source: "iana",
        extensions: ["m4s"]
      },
      "video/jpeg": {
        source: "iana",
        extensions: ["jpgv"]
      },
      "video/jpeg2000": {
        source: "iana"
      },
      "video/jpm": {
        source: "apache",
        extensions: ["jpm", "jpgm"]
      },
      "video/jxsv": {
        source: "iana"
      },
      "video/mj2": {
        source: "iana",
        extensions: ["mj2", "mjp2"]
      },
      "video/mp1s": {
        source: "iana"
      },
      "video/mp2p": {
        source: "iana"
      },
      "video/mp2t": {
        source: "iana",
        extensions: ["ts"]
      },
      "video/mp4": {
        source: "iana",
        compressible: false,
        extensions: ["mp4", "mp4v", "mpg4"]
      },
      "video/mp4v-es": {
        source: "iana"
      },
      "video/mpeg": {
        source: "iana",
        compressible: false,
        extensions: ["mpeg", "mpg", "mpe", "m1v", "m2v"]
      },
      "video/mpeg4-generic": {
        source: "iana"
      },
      "video/mpv": {
        source: "iana"
      },
      "video/nv": {
        source: "iana"
      },
      "video/ogg": {
        source: "iana",
        compressible: false,
        extensions: ["ogv"]
      },
      "video/parityfec": {
        source: "iana"
      },
      "video/pointer": {
        source: "iana"
      },
      "video/quicktime": {
        source: "iana",
        compressible: false,
        extensions: ["qt", "mov"]
      },
      "video/raptorfec": {
        source: "iana"
      },
      "video/raw": {
        source: "iana"
      },
      "video/rtp-enc-aescm128": {
        source: "iana"
      },
      "video/rtploopback": {
        source: "iana"
      },
      "video/rtx": {
        source: "iana"
      },
      "video/scip": {
        source: "iana"
      },
      "video/smpte291": {
        source: "iana"
      },
      "video/smpte292m": {
        source: "iana"
      },
      "video/ulpfec": {
        source: "iana"
      },
      "video/vc1": {
        source: "iana"
      },
      "video/vc2": {
        source: "iana"
      },
      "video/vnd.cctv": {
        source: "iana"
      },
      "video/vnd.dece.hd": {
        source: "iana",
        extensions: ["uvh", "uvvh"]
      },
      "video/vnd.dece.mobile": {
        source: "iana",
        extensions: ["uvm", "uvvm"]
      },
      "video/vnd.dece.mp4": {
        source: "iana"
      },
      "video/vnd.dece.pd": {
        source: "iana",
        extensions: ["uvp", "uvvp"]
      },
      "video/vnd.dece.sd": {
        source: "iana",
        extensions: ["uvs", "uvvs"]
      },
      "video/vnd.dece.video": {
        source: "iana",
        extensions: ["uvv", "uvvv"]
      },
      "video/vnd.directv.mpeg": {
        source: "iana"
      },
      "video/vnd.directv.mpeg-tts": {
        source: "iana"
      },
      "video/vnd.dlna.mpeg-tts": {
        source: "iana"
      },
      "video/vnd.dvb.file": {
        source: "iana",
        extensions: ["dvb"]
      },
      "video/vnd.fvt": {
        source: "iana",
        extensions: ["fvt"]
      },
      "video/vnd.hns.video": {
        source: "iana"
      },
      "video/vnd.iptvforum.1dparityfec-1010": {
        source: "iana"
      },
      "video/vnd.iptvforum.1dparityfec-2005": {
        source: "iana"
      },
      "video/vnd.iptvforum.2dparityfec-1010": {
        source: "iana"
      },
      "video/vnd.iptvforum.2dparityfec-2005": {
        source: "iana"
      },
      "video/vnd.iptvforum.ttsavc": {
        source: "iana"
      },
      "video/vnd.iptvforum.ttsmpeg2": {
        source: "iana"
      },
      "video/vnd.motorola.video": {
        source: "iana"
      },
      "video/vnd.motorola.videop": {
        source: "iana"
      },
      "video/vnd.mpegurl": {
        source: "iana",
        extensions: ["mxu", "m4u"]
      },
      "video/vnd.ms-playready.media.pyv": {
        source: "iana",
        extensions: ["pyv"]
      },
      "video/vnd.nokia.interleaved-multimedia": {
        source: "iana"
      },
      "video/vnd.nokia.mp4vr": {
        source: "iana"
      },
      "video/vnd.nokia.videovoip": {
        source: "iana"
      },
      "video/vnd.objectvideo": {
        source: "iana"
      },
      "video/vnd.radgamettools.bink": {
        source: "iana"
      },
      "video/vnd.radgamettools.smacker": {
        source: "iana"
      },
      "video/vnd.sealed.mpeg1": {
        source: "iana"
      },
      "video/vnd.sealed.mpeg4": {
        source: "iana"
      },
      "video/vnd.sealed.swf": {
        source: "iana"
      },
      "video/vnd.sealedmedia.softseal.mov": {
        source: "iana"
      },
      "video/vnd.uvvu.mp4": {
        source: "iana",
        extensions: ["uvu", "uvvu"]
      },
      "video/vnd.vivo": {
        source: "iana",
        extensions: ["viv"]
      },
      "video/vnd.youtube.yt": {
        source: "iana"
      },
      "video/vp8": {
        source: "iana"
      },
      "video/vp9": {
        source: "iana"
      },
      "video/webm": {
        source: "apache",
        compressible: false,
        extensions: ["webm"]
      },
      "video/x-f4v": {
        source: "apache",
        extensions: ["f4v"]
      },
      "video/x-fli": {
        source: "apache",
        extensions: ["fli"]
      },
      "video/x-flv": {
        source: "apache",
        compressible: false,
        extensions: ["flv"]
      },
      "video/x-m4v": {
        source: "apache",
        extensions: ["m4v"]
      },
      "video/x-matroska": {
        source: "apache",
        compressible: false,
        extensions: ["mkv", "mk3d", "mks"]
      },
      "video/x-mng": {
        source: "apache",
        extensions: ["mng"]
      },
      "video/x-ms-asf": {
        source: "apache",
        extensions: ["asf", "asx"]
      },
      "video/x-ms-vob": {
        source: "apache",
        extensions: ["vob"]
      },
      "video/x-ms-wm": {
        source: "apache",
        extensions: ["wm"]
      },
      "video/x-ms-wmv": {
        source: "apache",
        compressible: false,
        extensions: ["wmv"]
      },
      "video/x-ms-wmx": {
        source: "apache",
        extensions: ["wmx"]
      },
      "video/x-ms-wvx": {
        source: "apache",
        extensions: ["wvx"]
      },
      "video/x-msvideo": {
        source: "apache",
        extensions: ["avi"]
      },
      "video/x-sgi-movie": {
        source: "apache",
        extensions: ["movie"]
      },
      "video/x-smv": {
        source: "apache",
        extensions: ["smv"]
      },
      "x-conference/x-cooltalk": {
        source: "apache",
        extensions: ["ice"]
      },
      "x-shader/x-fragment": {
        compressible: true
      },
      "x-shader/x-vertex": {
        compressible: true
      }
    };
  }
});

// dependencies/mime-db/index.js
var require_mime_db = __commonJS({
  "dependencies/mime-db/index.js"(exports2, module2) {
    /*!
     * mime-db
     * Copyright(c) 2014 Jonathan Ong
     * Copyright(c) 2015-2022 Douglas Christopher Wilson
     * MIT Licensed
     */
    module2.exports = require_db();
  }
});

// dependencies/mime-types/index.js
var require_mime_types = __commonJS({
  "dependencies/mime-types/index.js"(exports2) {
    "use strict";
    /*!
     * mime-types
     * Copyright(c) 2014 Jonathan Ong
     * Copyright(c) 2015 Douglas Christopher Wilson
     * MIT Licensed
     */
    var db = require_mime_db();
    var extname = require("path").extname;
    var EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/;
    var TEXT_TYPE_REGEXP = /^text\//i;
    exports2.charset = charset;
    exports2.charsets = { lookup: charset };
    exports2.contentType = contentType;
    exports2.extension = extension;
    exports2.extensions = /* @__PURE__ */ Object.create(null);
    exports2.lookup = lookup;
    exports2.types = /* @__PURE__ */ Object.create(null);
    populateMaps(exports2.extensions, exports2.types);
    function charset(type) {
      if (!type || typeof type !== "string") {
        return false;
      }
      var match = EXTRACT_TYPE_REGEXP.exec(type);
      var mime = match && db[match[1].toLowerCase()];
      if (mime && mime.charset) {
        return mime.charset;
      }
      if (match && TEXT_TYPE_REGEXP.test(match[1])) {
        return "UTF-8";
      }
      return false;
    }
    function contentType(str) {
      if (!str || typeof str !== "string") {
        return false;
      }
      var mime = str.indexOf("/") === -1 ? exports2.lookup(str) : str;
      if (!mime) {
        return false;
      }
      if (mime.indexOf("charset") === -1) {
        var charset2 = exports2.charset(mime);
        if (charset2) mime += "; charset=" + charset2.toLowerCase();
      }
      return mime;
    }
    function extension(type) {
      if (!type || typeof type !== "string") {
        return false;
      }
      var match = EXTRACT_TYPE_REGEXP.exec(type);
      var exts = match && exports2.extensions[match[1].toLowerCase()];
      if (!exts || !exts.length) {
        return false;
      }
      return exts[0];
    }
    function lookup(path2) {
      if (!path2 || typeof path2 !== "string") {
        return false;
      }
      var extension2 = extname("x." + path2).toLowerCase().substr(1);
      if (!extension2) {
        return false;
      }
      return exports2.types[extension2] || false;
    }
    function populateMaps(extensions, types) {
      var preference = ["nginx", "apache", void 0, "iana"];
      Object.keys(db).forEach(function forEachMimeType(type) {
        var mime = db[type];
        var exts = mime.extensions;
        if (!exts || !exts.length) {
          return;
        }
        extensions[type] = exts;
        for (var i = 0; i < exts.length; i++) {
          var extension2 = exts[i];
          if (types[extension2]) {
            var from = preference.indexOf(db[types[extension2]].source);
            var to = preference.indexOf(mime.source);
            if (types[extension2] !== "application/octet-stream" && (from > to || from === to && types[extension2].substr(0, 12) === "application/")) {
              continue;
            }
          }
          types[extension2] = type;
        }
      });
    }
  }
});

// dependencies/asynckit/lib/defer.js
var require_defer = __commonJS({
  "dependencies/asynckit/lib/defer.js"(exports2, module2) {
    module2.exports = defer;
    function defer(fn) {
      var nextTick = typeof setImmediate == "function" ? setImmediate : typeof process == "object" && typeof process.nextTick == "function" ? process.nextTick : null;
      if (nextTick) {
        nextTick(fn);
      } else {
        setTimeout(fn, 0);
      }
    }
  }
});

// dependencies/asynckit/lib/async.js
var require_async = __commonJS({
  "dependencies/asynckit/lib/async.js"(exports2, module2) {
    var defer = require_defer();
    module2.exports = async;
    function async(callback) {
      var isAsync = false;
      defer(function() {
        isAsync = true;
      });
      return function async_callback(err, result) {
        if (isAsync) {
          callback(err, result);
        } else {
          defer(function nextTick_callback() {
            callback(err, result);
          });
        }
      };
    }
  }
});

// dependencies/asynckit/lib/abort.js
var require_abort = __commonJS({
  "dependencies/asynckit/lib/abort.js"(exports2, module2) {
    module2.exports = abort;
    function abort(state) {
      Object.keys(state.jobs).forEach(clean.bind(state));
      state.jobs = {};
    }
    function clean(key) {
      if (typeof this.jobs[key] == "function") {
        this.jobs[key]();
      }
    }
  }
});

// dependencies/asynckit/lib/iterate.js
var require_iterate = __commonJS({
  "dependencies/asynckit/lib/iterate.js"(exports2, module2) {
    var async = require_async();
    var abort = require_abort();
    module2.exports = iterate;
    function iterate(list, iterator, state, callback) {
      var key = state["keyedList"] ? state["keyedList"][state.index] : state.index;
      state.jobs[key] = runJob(iterator, key, list[key], function(error, output) {
        if (!(key in state.jobs)) {
          return;
        }
        delete state.jobs[key];
        if (error) {
          abort(state);
        } else {
          state.results[key] = output;
        }
        callback(error, state.results);
      });
    }
    function runJob(iterator, key, item, callback) {
      var aborter;
      if (iterator.length == 2) {
        aborter = iterator(item, async(callback));
      } else {
        aborter = iterator(item, key, async(callback));
      }
      return aborter;
    }
  }
});

// dependencies/asynckit/lib/state.js
var require_state = __commonJS({
  "dependencies/asynckit/lib/state.js"(exports2, module2) {
    module2.exports = state;
    function state(list, sortMethod) {
      var isNamedList = !Array.isArray(list), initState = {
        index: 0,
        keyedList: isNamedList || sortMethod ? Object.keys(list) : null,
        jobs: {},
        results: isNamedList ? {} : [],
        size: isNamedList ? Object.keys(list).length : list.length
      };
      if (sortMethod) {
        initState.keyedList.sort(isNamedList ? sortMethod : function(a, b) {
          return sortMethod(list[a], list[b]);
        });
      }
      return initState;
    }
  }
});

// dependencies/asynckit/lib/terminator.js
var require_terminator = __commonJS({
  "dependencies/asynckit/lib/terminator.js"(exports2, module2) {
    var abort = require_abort();
    var async = require_async();
    module2.exports = terminator;
    function terminator(callback) {
      if (!Object.keys(this.jobs).length) {
        return;
      }
      this.index = this.size;
      abort(this);
      async(callback)(null, this.results);
    }
  }
});

// dependencies/asynckit/parallel.js
var require_parallel = __commonJS({
  "dependencies/asynckit/parallel.js"(exports2, module2) {
    var iterate = require_iterate();
    var initState = require_state();
    var terminator = require_terminator();
    module2.exports = parallel;
    function parallel(list, iterator, callback) {
      var state = initState(list);
      while (state.index < (state["keyedList"] || list).length) {
        iterate(list, iterator, state, function(error, result) {
          if (error) {
            callback(error, result);
            return;
          }
          if (Object.keys(state.jobs).length === 0) {
            callback(null, state.results);
            return;
          }
        });
        state.index++;
      }
      return terminator.bind(state, callback);
    }
  }
});

// dependencies/asynckit/serialOrdered.js
var require_serialOrdered = __commonJS({
  "dependencies/asynckit/serialOrdered.js"(exports2, module2) {
    var iterate = require_iterate();
    var initState = require_state();
    var terminator = require_terminator();
    module2.exports = serialOrdered;
    module2.exports.ascending = ascending;
    module2.exports.descending = descending;
    function serialOrdered(list, iterator, sortMethod, callback) {
      var state = initState(list, sortMethod);
      iterate(list, iterator, state, function iteratorHandler(error, result) {
        if (error) {
          callback(error, result);
          return;
        }
        state.index++;
        if (state.index < (state["keyedList"] || list).length) {
          iterate(list, iterator, state, iteratorHandler);
          return;
        }
        callback(null, state.results);
      });
      return terminator.bind(state, callback);
    }
    function ascending(a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    function descending(a, b) {
      return -1 * ascending(a, b);
    }
  }
});

// dependencies/asynckit/serial.js
var require_serial = __commonJS({
  "dependencies/asynckit/serial.js"(exports2, module2) {
    var serialOrdered = require_serialOrdered();
    module2.exports = serial;
    function serial(list, iterator, callback) {
      return serialOrdered(list, iterator, null, callback);
    }
  }
});

// dependencies/asynckit/index.js
var require_asynckit = __commonJS({
  "dependencies/asynckit/index.js"(exports2, module2) {
    module2.exports = {
      parallel: require_parallel(),
      serial: require_serial(),
      serialOrdered: require_serialOrdered()
    };
  }
});

// dependencies/es-object-atoms/index.js
var require_es_object_atoms = __commonJS({
  "dependencies/es-object-atoms/index.js"(exports2, module2) {
    "use strict";
    module2.exports = Object;
  }
});

// dependencies/es-errors/index.js
var require_es_errors = __commonJS({
  "dependencies/es-errors/index.js"(exports2, module2) {
    "use strict";
    module2.exports = Error;
  }
});

// dependencies/es-errors/eval.js
var require_eval = __commonJS({
  "dependencies/es-errors/eval.js"(exports2, module2) {
    "use strict";
    module2.exports = EvalError;
  }
});

// dependencies/es-errors/range.js
var require_range = __commonJS({
  "dependencies/es-errors/range.js"(exports2, module2) {
    "use strict";
    module2.exports = RangeError;
  }
});

// dependencies/es-errors/ref.js
var require_ref = __commonJS({
  "dependencies/es-errors/ref.js"(exports2, module2) {
    "use strict";
    module2.exports = ReferenceError;
  }
});

// dependencies/es-errors/syntax.js
var require_syntax = __commonJS({
  "dependencies/es-errors/syntax.js"(exports2, module2) {
    "use strict";
    module2.exports = SyntaxError;
  }
});

// dependencies/es-errors/type.js
var require_type = __commonJS({
  "dependencies/es-errors/type.js"(exports2, module2) {
    "use strict";
    module2.exports = TypeError;
  }
});

// dependencies/es-errors/uri.js
var require_uri = __commonJS({
  "dependencies/es-errors/uri.js"(exports2, module2) {
    "use strict";
    module2.exports = URIError;
  }
});

// dependencies/math-intrinsics/abs.js
var require_abs = __commonJS({
  "dependencies/math-intrinsics/abs.js"(exports2, module2) {
    "use strict";
    module2.exports = Math.abs;
  }
});

// dependencies/math-intrinsics/floor.js
var require_floor = __commonJS({
  "dependencies/math-intrinsics/floor.js"(exports2, module2) {
    "use strict";
    module2.exports = Math.floor;
  }
});

// dependencies/math-intrinsics/max.js
var require_max = __commonJS({
  "dependencies/math-intrinsics/max.js"(exports2, module2) {
    "use strict";
    module2.exports = Math.max;
  }
});

// dependencies/math-intrinsics/min.js
var require_min = __commonJS({
  "dependencies/math-intrinsics/min.js"(exports2, module2) {
    "use strict";
    module2.exports = Math.min;
  }
});

// dependencies/math-intrinsics/pow.js
var require_pow = __commonJS({
  "dependencies/math-intrinsics/pow.js"(exports2, module2) {
    "use strict";
    module2.exports = Math.pow;
  }
});

// dependencies/math-intrinsics/round.js
var require_round = __commonJS({
  "dependencies/math-intrinsics/round.js"(exports2, module2) {
    "use strict";
    module2.exports = Math.round;
  }
});

// dependencies/math-intrinsics/isNaN.js
var require_isNaN = __commonJS({
  "dependencies/math-intrinsics/isNaN.js"(exports2, module2) {
    "use strict";
    module2.exports = Number.isNaN || function isNaN2(a) {
      return a !== a;
    };
  }
});

// dependencies/math-intrinsics/sign.js
var require_sign = __commonJS({
  "dependencies/math-intrinsics/sign.js"(exports2, module2) {
    "use strict";
    var $isNaN = require_isNaN();
    module2.exports = function sign(number) {
      if ($isNaN(number) || number === 0) {
        return number;
      }
      return number < 0 ? -1 : 1;
    };
  }
});

// dependencies/gopd/gOPD.js
var require_gOPD = __commonJS({
  "dependencies/gopd/gOPD.js"(exports2, module2) {
    "use strict";
    module2.exports = Object.getOwnPropertyDescriptor;
  }
});

// dependencies/gopd/index.js
var require_gopd = __commonJS({
  "dependencies/gopd/index.js"(exports2, module2) {
    "use strict";
    var $gOPD = require_gOPD();
    if ($gOPD) {
      try {
        $gOPD([], "length");
      } catch (e) {
        $gOPD = null;
      }
    }
    module2.exports = $gOPD;
  }
});

// dependencies/es-define-property/index.js
var require_es_define_property = __commonJS({
  "dependencies/es-define-property/index.js"(exports2, module2) {
    "use strict";
    var $defineProperty = Object.defineProperty || false;
    if ($defineProperty) {
      try {
        $defineProperty({}, "a", { value: 1 });
      } catch (e) {
        $defineProperty = false;
      }
    }
    module2.exports = $defineProperty;
  }
});

// dependencies/has-symbols/shams.js
var require_shams = __commonJS({
  "dependencies/has-symbols/shams.js"(exports2, module2) {
    "use strict";
    module2.exports = function hasSymbols() {
      if (typeof Symbol !== "function" || typeof Object.getOwnPropertySymbols !== "function") {
        return false;
      }
      if (typeof Symbol.iterator === "symbol") {
        return true;
      }
      var obj = {};
      var sym = /* @__PURE__ */ Symbol("test");
      var symObj = Object(sym);
      if (typeof sym === "string") {
        return false;
      }
      if (Object.prototype.toString.call(sym) !== "[object Symbol]") {
        return false;
      }
      if (Object.prototype.toString.call(symObj) !== "[object Symbol]") {
        return false;
      }
      var symVal = 42;
      obj[sym] = symVal;
      for (var _ in obj) {
        return false;
      }
      if (typeof Object.keys === "function" && Object.keys(obj).length !== 0) {
        return false;
      }
      if (typeof Object.getOwnPropertyNames === "function" && Object.getOwnPropertyNames(obj).length !== 0) {
        return false;
      }
      var syms = Object.getOwnPropertySymbols(obj);
      if (syms.length !== 1 || syms[0] !== sym) {
        return false;
      }
      if (!Object.prototype.propertyIsEnumerable.call(obj, sym)) {
        return false;
      }
      if (typeof Object.getOwnPropertyDescriptor === "function") {
        var descriptor = (
          /** @type {PropertyDescriptor} */
          Object.getOwnPropertyDescriptor(obj, sym)
        );
        if (descriptor.value !== symVal || descriptor.enumerable !== true) {
          return false;
        }
      }
      return true;
    };
  }
});

// dependencies/has-symbols/index.js
var require_has_symbols = __commonJS({
  "dependencies/has-symbols/index.js"(exports2, module2) {
    "use strict";
    var origSymbol = typeof Symbol !== "undefined" && Symbol;
    var hasSymbolSham = require_shams();
    module2.exports = function hasNativeSymbols() {
      if (typeof origSymbol !== "function") {
        return false;
      }
      if (typeof Symbol !== "function") {
        return false;
      }
      if (typeof origSymbol("foo") !== "symbol") {
        return false;
      }
      if (typeof /* @__PURE__ */ Symbol("bar") !== "symbol") {
        return false;
      }
      return hasSymbolSham();
    };
  }
});

// dependencies/get-proto/Reflect.getPrototypeOf.js
var require_Reflect_getPrototypeOf = __commonJS({
  "dependencies/get-proto/Reflect.getPrototypeOf.js"(exports2, module2) {
    "use strict";
    module2.exports = typeof Reflect !== "undefined" && Reflect.getPrototypeOf || null;
  }
});

// dependencies/get-proto/Object.getPrototypeOf.js
var require_Object_getPrototypeOf = __commonJS({
  "dependencies/get-proto/Object.getPrototypeOf.js"(exports2, module2) {
    "use strict";
    var $Object = require_es_object_atoms();
    module2.exports = $Object.getPrototypeOf || null;
  }
});

// dependencies/function-bind/implementation.js
var require_implementation = __commonJS({
  "dependencies/function-bind/implementation.js"(exports2, module2) {
    "use strict";
    var ERROR_MESSAGE = "Function.prototype.bind called on incompatible ";
    var toStr = Object.prototype.toString;
    var max = Math.max;
    var funcType = "[object Function]";
    var concatty = function concatty2(a, b) {
      var arr = [];
      for (var i = 0; i < a.length; i += 1) {
        arr[i] = a[i];
      }
      for (var j = 0; j < b.length; j += 1) {
        arr[j + a.length] = b[j];
      }
      return arr;
    };
    var slicy = function slicy2(arrLike, offset) {
      var arr = [];
      for (var i = offset || 0, j = 0; i < arrLike.length; i += 1, j += 1) {
        arr[j] = arrLike[i];
      }
      return arr;
    };
    var joiny = function(arr, joiner) {
      var str = "";
      for (var i = 0; i < arr.length; i += 1) {
        str += arr[i];
        if (i + 1 < arr.length) {
          str += joiner;
        }
      }
      return str;
    };
    module2.exports = function bind(that) {
      var target = this;
      if (typeof target !== "function" || toStr.apply(target) !== funcType) {
        throw new TypeError(ERROR_MESSAGE + target);
      }
      var args = slicy(arguments, 1);
      var bound;
      var binder = function() {
        if (this instanceof bound) {
          var result = target.apply(
            this,
            concatty(args, arguments)
          );
          if (Object(result) === result) {
            return result;
          }
          return this;
        }
        return target.apply(
          that,
          concatty(args, arguments)
        );
      };
      var boundLength = max(0, target.length - args.length);
      var boundArgs = [];
      for (var i = 0; i < boundLength; i++) {
        boundArgs[i] = "$" + i;
      }
      bound = Function("binder", "return function (" + joiny(boundArgs, ",") + "){ return binder.apply(this,arguments); }")(binder);
      if (target.prototype) {
        var Empty = function Empty2() {
        };
        Empty.prototype = target.prototype;
        bound.prototype = new Empty();
        Empty.prototype = null;
      }
      return bound;
    };
  }
});

// dependencies/function-bind/index.js
var require_function_bind = __commonJS({
  "dependencies/function-bind/index.js"(exports2, module2) {
    "use strict";
    var implementation = require_implementation();
    module2.exports = Function.prototype.bind || implementation;
  }
});

// dependencies/call-bind-apply-helpers/functionCall.js
var require_functionCall = __commonJS({
  "dependencies/call-bind-apply-helpers/functionCall.js"(exports2, module2) {
    "use strict";
    module2.exports = Function.prototype.call;
  }
});

// dependencies/call-bind-apply-helpers/functionApply.js
var require_functionApply = __commonJS({
  "dependencies/call-bind-apply-helpers/functionApply.js"(exports2, module2) {
    "use strict";
    module2.exports = Function.prototype.apply;
  }
});

// dependencies/call-bind-apply-helpers/reflectApply.js
var require_reflectApply = __commonJS({
  "dependencies/call-bind-apply-helpers/reflectApply.js"(exports2, module2) {
    "use strict";
    module2.exports = typeof Reflect !== "undefined" && Reflect && Reflect.apply;
  }
});

// dependencies/call-bind-apply-helpers/actualApply.js
var require_actualApply = __commonJS({
  "dependencies/call-bind-apply-helpers/actualApply.js"(exports2, module2) {
    "use strict";
    var bind = require_function_bind();
    var $apply = require_functionApply();
    var $call = require_functionCall();
    var $reflectApply = require_reflectApply();
    module2.exports = $reflectApply || bind.call($call, $apply);
  }
});

// dependencies/call-bind-apply-helpers/index.js
var require_call_bind_apply_helpers = __commonJS({
  "dependencies/call-bind-apply-helpers/index.js"(exports2, module2) {
    "use strict";
    var bind = require_function_bind();
    var $TypeError = require_type();
    var $call = require_functionCall();
    var $actualApply = require_actualApply();
    module2.exports = function callBindBasic(args) {
      if (args.length < 1 || typeof args[0] !== "function") {
        throw new $TypeError("a function is required");
      }
      return $actualApply(bind, $call, args);
    };
  }
});

// dependencies/dunder-proto/get.js
var require_get = __commonJS({
  "dependencies/dunder-proto/get.js"(exports2, module2) {
    "use strict";
    var callBind = require_call_bind_apply_helpers();
    var gOPD = require_gopd();
    var hasProtoAccessor;
    try {
      hasProtoAccessor = /** @type {{ __proto__?: typeof Array.prototype }} */
      [].__proto__ === Array.prototype;
    } catch (e) {
      if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ERR_PROTO_ACCESS") {
        throw e;
      }
    }
    var desc = !!hasProtoAccessor && gOPD && gOPD(
      Object.prototype,
      /** @type {keyof typeof Object.prototype} */
      "__proto__"
    );
    var $Object = Object;
    var $getPrototypeOf = $Object.getPrototypeOf;
    module2.exports = desc && typeof desc.get === "function" ? callBind([desc.get]) : typeof $getPrototypeOf === "function" ? (
      /** @type {import('./get')} */
      function getDunder(value) {
        return $getPrototypeOf(value == null ? value : $Object(value));
      }
    ) : false;
  }
});

// dependencies/get-proto/index.js
var require_get_proto = __commonJS({
  "dependencies/get-proto/index.js"(exports2, module2) {
    "use strict";
    var reflectGetProto = require_Reflect_getPrototypeOf();
    var originalGetProto = require_Object_getPrototypeOf();
    var getDunderProto = require_get();
    module2.exports = reflectGetProto ? function getProto(O) {
      return reflectGetProto(O);
    } : originalGetProto ? function getProto(O) {
      if (!O || typeof O !== "object" && typeof O !== "function") {
        throw new TypeError("getProto: not an object");
      }
      return originalGetProto(O);
    } : getDunderProto ? function getProto(O) {
      return getDunderProto(O);
    } : null;
  }
});

// dependencies/hasown/index.js
var require_hasown = __commonJS({
  "dependencies/hasown/index.js"(exports2, module2) {
    "use strict";
    var call = Function.prototype.call;
    var $hasOwn = Object.prototype.hasOwnProperty;
    var bind = require_function_bind();
    module2.exports = bind.call(call, $hasOwn);
  }
});

// dependencies/get-intrinsic/index.js
var require_get_intrinsic = __commonJS({
  "dependencies/get-intrinsic/index.js"(exports2, module2) {
    "use strict";
    var undefined2;
    var $Object = require_es_object_atoms();
    var $Error = require_es_errors();
    var $EvalError = require_eval();
    var $RangeError = require_range();
    var $ReferenceError = require_ref();
    var $SyntaxError = require_syntax();
    var $TypeError = require_type();
    var $URIError = require_uri();
    var abs = require_abs();
    var floor = require_floor();
    var max = require_max();
    var min = require_min();
    var pow = require_pow();
    var round = require_round();
    var sign = require_sign();
    var $Function = Function;
    var getEvalledConstructor = function(expressionSyntax) {
      try {
        return $Function('"use strict"; return (' + expressionSyntax + ").constructor;")();
      } catch (e) {
      }
    };
    var $gOPD = require_gopd();
    var $defineProperty = require_es_define_property();
    var throwTypeError = function() {
      throw new $TypeError();
    };
    var ThrowTypeError = $gOPD ? (function() {
      try {
        arguments.callee;
        return throwTypeError;
      } catch (calleeThrows) {
        try {
          return $gOPD(arguments, "callee").get;
        } catch (gOPDthrows) {
          return throwTypeError;
        }
      }
    })() : throwTypeError;
    var hasSymbols = require_has_symbols()();
    var getProto = require_get_proto();
    var $ObjectGPO = require_Object_getPrototypeOf();
    var $ReflectGPO = require_Reflect_getPrototypeOf();
    var $apply = require_functionApply();
    var $call = require_functionCall();
    var needsEval = {};
    var TypedArray = typeof Uint8Array === "undefined" || !getProto ? undefined2 : getProto(Uint8Array);
    var INTRINSICS = {
      __proto__: null,
      "%AggregateError%": typeof AggregateError === "undefined" ? undefined2 : AggregateError,
      "%Array%": Array,
      "%ArrayBuffer%": typeof ArrayBuffer === "undefined" ? undefined2 : ArrayBuffer,
      "%ArrayIteratorPrototype%": hasSymbols && getProto ? getProto([][Symbol.iterator]()) : undefined2,
      "%AsyncFromSyncIteratorPrototype%": undefined2,
      "%AsyncFunction%": needsEval,
      "%AsyncGenerator%": needsEval,
      "%AsyncGeneratorFunction%": needsEval,
      "%AsyncIteratorPrototype%": needsEval,
      "%Atomics%": typeof Atomics === "undefined" ? undefined2 : Atomics,
      "%BigInt%": typeof BigInt === "undefined" ? undefined2 : BigInt,
      "%BigInt64Array%": typeof BigInt64Array === "undefined" ? undefined2 : BigInt64Array,
      "%BigUint64Array%": typeof BigUint64Array === "undefined" ? undefined2 : BigUint64Array,
      "%Boolean%": Boolean,
      "%DataView%": typeof DataView === "undefined" ? undefined2 : DataView,
      "%Date%": Date,
      "%decodeURI%": decodeURI,
      "%decodeURIComponent%": decodeURIComponent,
      "%encodeURI%": encodeURI,
      "%encodeURIComponent%": encodeURIComponent,
      "%Error%": $Error,
      "%eval%": eval,
      // eslint-disable-line no-eval
      "%EvalError%": $EvalError,
      "%Float16Array%": typeof Float16Array === "undefined" ? undefined2 : Float16Array,
      "%Float32Array%": typeof Float32Array === "undefined" ? undefined2 : Float32Array,
      "%Float64Array%": typeof Float64Array === "undefined" ? undefined2 : Float64Array,
      "%FinalizationRegistry%": typeof FinalizationRegistry === "undefined" ? undefined2 : FinalizationRegistry,
      "%Function%": $Function,
      "%GeneratorFunction%": needsEval,
      "%Int8Array%": typeof Int8Array === "undefined" ? undefined2 : Int8Array,
      "%Int16Array%": typeof Int16Array === "undefined" ? undefined2 : Int16Array,
      "%Int32Array%": typeof Int32Array === "undefined" ? undefined2 : Int32Array,
      "%isFinite%": isFinite,
      "%isNaN%": isNaN,
      "%IteratorPrototype%": hasSymbols && getProto ? getProto(getProto([][Symbol.iterator]())) : undefined2,
      "%JSON%": typeof JSON === "object" ? JSON : undefined2,
      "%Map%": typeof Map === "undefined" ? undefined2 : Map,
      "%MapIteratorPrototype%": typeof Map === "undefined" || !hasSymbols || !getProto ? undefined2 : getProto((/* @__PURE__ */ new Map())[Symbol.iterator]()),
      "%Math%": Math,
      "%Number%": Number,
      "%Object%": $Object,
      "%Object.getOwnPropertyDescriptor%": $gOPD,
      "%parseFloat%": parseFloat,
      "%parseInt%": parseInt,
      "%Promise%": typeof Promise === "undefined" ? undefined2 : Promise,
      "%Proxy%": typeof Proxy === "undefined" ? undefined2 : Proxy,
      "%RangeError%": $RangeError,
      "%ReferenceError%": $ReferenceError,
      "%Reflect%": typeof Reflect === "undefined" ? undefined2 : Reflect,
      "%RegExp%": RegExp,
      "%Set%": typeof Set === "undefined" ? undefined2 : Set,
      "%SetIteratorPrototype%": typeof Set === "undefined" || !hasSymbols || !getProto ? undefined2 : getProto((/* @__PURE__ */ new Set())[Symbol.iterator]()),
      "%SharedArrayBuffer%": typeof SharedArrayBuffer === "undefined" ? undefined2 : SharedArrayBuffer,
      "%String%": String,
      "%StringIteratorPrototype%": hasSymbols && getProto ? getProto(""[Symbol.iterator]()) : undefined2,
      "%Symbol%": hasSymbols ? Symbol : undefined2,
      "%SyntaxError%": $SyntaxError,
      "%ThrowTypeError%": ThrowTypeError,
      "%TypedArray%": TypedArray,
      "%TypeError%": $TypeError,
      "%Uint8Array%": typeof Uint8Array === "undefined" ? undefined2 : Uint8Array,
      "%Uint8ClampedArray%": typeof Uint8ClampedArray === "undefined" ? undefined2 : Uint8ClampedArray,
      "%Uint16Array%": typeof Uint16Array === "undefined" ? undefined2 : Uint16Array,
      "%Uint32Array%": typeof Uint32Array === "undefined" ? undefined2 : Uint32Array,
      "%URIError%": $URIError,
      "%WeakMap%": typeof WeakMap === "undefined" ? undefined2 : WeakMap,
      "%WeakRef%": typeof WeakRef === "undefined" ? undefined2 : WeakRef,
      "%WeakSet%": typeof WeakSet === "undefined" ? undefined2 : WeakSet,
      "%Function.prototype.call%": $call,
      "%Function.prototype.apply%": $apply,
      "%Object.defineProperty%": $defineProperty,
      "%Object.getPrototypeOf%": $ObjectGPO,
      "%Math.abs%": abs,
      "%Math.floor%": floor,
      "%Math.max%": max,
      "%Math.min%": min,
      "%Math.pow%": pow,
      "%Math.round%": round,
      "%Math.sign%": sign,
      "%Reflect.getPrototypeOf%": $ReflectGPO
    };
    if (getProto) {
      try {
        null.error;
      } catch (e) {
        errorProto = getProto(getProto(e));
        INTRINSICS["%Error.prototype%"] = errorProto;
      }
    }
    var errorProto;
    var doEval = function doEval2(name) {
      var value;
      if (name === "%AsyncFunction%") {
        value = getEvalledConstructor("async function () {}");
      } else if (name === "%GeneratorFunction%") {
        value = getEvalledConstructor("function* () {}");
      } else if (name === "%AsyncGeneratorFunction%") {
        value = getEvalledConstructor("async function* () {}");
      } else if (name === "%AsyncGenerator%") {
        var fn = doEval2("%AsyncGeneratorFunction%");
        if (fn) {
          value = fn.prototype;
        }
      } else if (name === "%AsyncIteratorPrototype%") {
        var gen = doEval2("%AsyncGenerator%");
        if (gen && getProto) {
          value = getProto(gen.prototype);
        }
      }
      INTRINSICS[name] = value;
      return value;
    };
    var LEGACY_ALIASES = {
      __proto__: null,
      "%ArrayBufferPrototype%": ["ArrayBuffer", "prototype"],
      "%ArrayPrototype%": ["Array", "prototype"],
      "%ArrayProto_entries%": ["Array", "prototype", "entries"],
      "%ArrayProto_forEach%": ["Array", "prototype", "forEach"],
      "%ArrayProto_keys%": ["Array", "prototype", "keys"],
      "%ArrayProto_values%": ["Array", "prototype", "values"],
      "%AsyncFunctionPrototype%": ["AsyncFunction", "prototype"],
      "%AsyncGenerator%": ["AsyncGeneratorFunction", "prototype"],
      "%AsyncGeneratorPrototype%": ["AsyncGeneratorFunction", "prototype", "prototype"],
      "%BooleanPrototype%": ["Boolean", "prototype"],
      "%DataViewPrototype%": ["DataView", "prototype"],
      "%DatePrototype%": ["Date", "prototype"],
      "%ErrorPrototype%": ["Error", "prototype"],
      "%EvalErrorPrototype%": ["EvalError", "prototype"],
      "%Float32ArrayPrototype%": ["Float32Array", "prototype"],
      "%Float64ArrayPrototype%": ["Float64Array", "prototype"],
      "%FunctionPrototype%": ["Function", "prototype"],
      "%Generator%": ["GeneratorFunction", "prototype"],
      "%GeneratorPrototype%": ["GeneratorFunction", "prototype", "prototype"],
      "%Int8ArrayPrototype%": ["Int8Array", "prototype"],
      "%Int16ArrayPrototype%": ["Int16Array", "prototype"],
      "%Int32ArrayPrototype%": ["Int32Array", "prototype"],
      "%JSONParse%": ["JSON", "parse"],
      "%JSONStringify%": ["JSON", "stringify"],
      "%MapPrototype%": ["Map", "prototype"],
      "%NumberPrototype%": ["Number", "prototype"],
      "%ObjectPrototype%": ["Object", "prototype"],
      "%ObjProto_toString%": ["Object", "prototype", "toString"],
      "%ObjProto_valueOf%": ["Object", "prototype", "valueOf"],
      "%PromisePrototype%": ["Promise", "prototype"],
      "%PromiseProto_then%": ["Promise", "prototype", "then"],
      "%Promise_all%": ["Promise", "all"],
      "%Promise_reject%": ["Promise", "reject"],
      "%Promise_resolve%": ["Promise", "resolve"],
      "%RangeErrorPrototype%": ["RangeError", "prototype"],
      "%ReferenceErrorPrototype%": ["ReferenceError", "prototype"],
      "%RegExpPrototype%": ["RegExp", "prototype"],
      "%SetPrototype%": ["Set", "prototype"],
      "%SharedArrayBufferPrototype%": ["SharedArrayBuffer", "prototype"],
      "%StringPrototype%": ["String", "prototype"],
      "%SymbolPrototype%": ["Symbol", "prototype"],
      "%SyntaxErrorPrototype%": ["SyntaxError", "prototype"],
      "%TypedArrayPrototype%": ["TypedArray", "prototype"],
      "%TypeErrorPrototype%": ["TypeError", "prototype"],
      "%Uint8ArrayPrototype%": ["Uint8Array", "prototype"],
      "%Uint8ClampedArrayPrototype%": ["Uint8ClampedArray", "prototype"],
      "%Uint16ArrayPrototype%": ["Uint16Array", "prototype"],
      "%Uint32ArrayPrototype%": ["Uint32Array", "prototype"],
      "%URIErrorPrototype%": ["URIError", "prototype"],
      "%WeakMapPrototype%": ["WeakMap", "prototype"],
      "%WeakSetPrototype%": ["WeakSet", "prototype"]
    };
    var bind = require_function_bind();
    var hasOwn = require_hasown();
    var $concat = bind.call($call, Array.prototype.concat);
    var $spliceApply = bind.call($apply, Array.prototype.splice);
    var $replace = bind.call($call, String.prototype.replace);
    var $strSlice = bind.call($call, String.prototype.slice);
    var $exec = bind.call($call, RegExp.prototype.exec);
    var rePropName = /[^%.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|%$))/g;
    var reEscapeChar = /\\(\\)?/g;
    var stringToPath = function stringToPath2(string) {
      var first = $strSlice(string, 0, 1);
      var last = $strSlice(string, -1);
      if (first === "%" && last !== "%") {
        throw new $SyntaxError("invalid intrinsic syntax, expected closing `%`");
      } else if (last === "%" && first !== "%") {
        throw new $SyntaxError("invalid intrinsic syntax, expected opening `%`");
      }
      var result = [];
      $replace(string, rePropName, function(match, number, quote, subString) {
        result[result.length] = quote ? $replace(subString, reEscapeChar, "$1") : number || match;
      });
      return result;
    };
    var getBaseIntrinsic = function getBaseIntrinsic2(name, allowMissing) {
      var intrinsicName = name;
      var alias;
      if (hasOwn(LEGACY_ALIASES, intrinsicName)) {
        alias = LEGACY_ALIASES[intrinsicName];
        intrinsicName = "%" + alias[0] + "%";
      }
      if (hasOwn(INTRINSICS, intrinsicName)) {
        var value = INTRINSICS[intrinsicName];
        if (value === needsEval) {
          value = doEval(intrinsicName);
        }
        if (typeof value === "undefined" && !allowMissing) {
          throw new $TypeError("intrinsic " + name + " exists, but is not available. Please file an issue!");
        }
        return {
          alias,
          name: intrinsicName,
          value
        };
      }
      throw new $SyntaxError("intrinsic " + name + " does not exist!");
    };
    module2.exports = function GetIntrinsic(name, allowMissing) {
      if (typeof name !== "string" || name.length === 0) {
        throw new $TypeError("intrinsic name must be a non-empty string");
      }
      if (arguments.length > 1 && typeof allowMissing !== "boolean") {
        throw new $TypeError('"allowMissing" argument must be a boolean');
      }
      if ($exec(/^%?[^%]*%?$/, name) === null) {
        throw new $SyntaxError("`%` may not be present anywhere but at the beginning and end of the intrinsic name");
      }
      var parts = stringToPath(name);
      var intrinsicBaseName = parts.length > 0 ? parts[0] : "";
      var intrinsic = getBaseIntrinsic("%" + intrinsicBaseName + "%", allowMissing);
      var intrinsicRealName = intrinsic.name;
      var value = intrinsic.value;
      var skipFurtherCaching = false;
      var alias = intrinsic.alias;
      if (alias) {
        intrinsicBaseName = alias[0];
        $spliceApply(parts, $concat([0, 1], alias));
      }
      for (var i = 1, isOwn = true; i < parts.length; i += 1) {
        var part = parts[i];
        var first = $strSlice(part, 0, 1);
        var last = $strSlice(part, -1);
        if ((first === '"' || first === "'" || first === "`" || (last === '"' || last === "'" || last === "`")) && first !== last) {
          throw new $SyntaxError("property names with quotes must have matching quotes");
        }
        if (part === "constructor" || !isOwn) {
          skipFurtherCaching = true;
        }
        intrinsicBaseName += "." + part;
        intrinsicRealName = "%" + intrinsicBaseName + "%";
        if (hasOwn(INTRINSICS, intrinsicRealName)) {
          value = INTRINSICS[intrinsicRealName];
        } else if (value != null) {
          if (!(part in value)) {
            if (!allowMissing) {
              throw new $TypeError("base intrinsic for " + name + " exists, but the property is not available.");
            }
            return void undefined2;
          }
          if ($gOPD && i + 1 >= parts.length) {
            var desc = $gOPD(value, part);
            isOwn = !!desc;
            if (isOwn && "get" in desc && !("originalValue" in desc.get)) {
              value = desc.get;
            } else {
              value = value[part];
            }
          } else {
            isOwn = hasOwn(value, part);
            value = value[part];
          }
          if (isOwn && !skipFurtherCaching) {
            INTRINSICS[intrinsicRealName] = value;
          }
        }
      }
      return value;
    };
  }
});

// dependencies/has-tostringtag/shams.js
var require_shams2 = __commonJS({
  "dependencies/has-tostringtag/shams.js"(exports2, module2) {
    "use strict";
    var hasSymbols = require_shams();
    module2.exports = function hasToStringTagShams() {
      return hasSymbols() && !!Symbol.toStringTag;
    };
  }
});

// dependencies/es-set-tostringtag/index.js
var require_es_set_tostringtag = __commonJS({
  "dependencies/es-set-tostringtag/index.js"(exports2, module2) {
    "use strict";
    var GetIntrinsic = require_get_intrinsic();
    var $defineProperty = GetIntrinsic("%Object.defineProperty%", true);
    var hasToStringTag = require_shams2()();
    var hasOwn = require_hasown();
    var $TypeError = require_type();
    var toStringTag = hasToStringTag ? Symbol.toStringTag : null;
    module2.exports = function setToStringTag(object, value) {
      var overrideIfSet = arguments.length > 2 && !!arguments[2] && arguments[2].force;
      var nonConfigurable = arguments.length > 2 && !!arguments[2] && arguments[2].nonConfigurable;
      if (typeof overrideIfSet !== "undefined" && typeof overrideIfSet !== "boolean" || typeof nonConfigurable !== "undefined" && typeof nonConfigurable !== "boolean") {
        throw new $TypeError("if provided, the `overrideIfSet` and `nonConfigurable` options must be booleans");
      }
      if (toStringTag && (overrideIfSet || !hasOwn(object, toStringTag))) {
        if ($defineProperty) {
          $defineProperty(object, toStringTag, {
            configurable: !nonConfigurable,
            enumerable: false,
            value,
            writable: false
          });
        } else {
          object[toStringTag] = value;
        }
      }
    };
  }
});

// dependencies/form-data/lib/populate.js
var require_populate = __commonJS({
  "dependencies/form-data/lib/populate.js"(exports2, module2) {
    "use strict";
    module2.exports = function(dst, src) {
      Object.keys(src).forEach(function(prop) {
        dst[prop] = dst[prop] || src[prop];
      });
      return dst;
    };
  }
});

// dependencies/form-data/lib/form_data.js
var require_form_data = __commonJS({
  "dependencies/form-data/lib/form_data.js"(exports2, module2) {
    "use strict";
    var CombinedStream = require_combined_stream();
    var util = require("util");
    var path2 = require("path");
    var http = require("http");
    var https = require("https");
    var parseUrl = require("url").parse;
    var fs2 = require("fs");
    var Stream = require("stream").Stream;
    var crypto2 = require("crypto");
    var mime = require_mime_types();
    var asynckit = require_asynckit();
    var setToStringTag = require_es_set_tostringtag();
    var hasOwn = require_hasown();
    var populate = require_populate();
    function escapeHeaderParam(str) {
      return String(str).replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
    }
    function FormData2(options) {
      if (!(this instanceof FormData2)) {
        return new FormData2(options);
      }
      this._overheadLength = 0;
      this._valueLength = 0;
      this._valuesToMeasure = [];
      CombinedStream.call(this);
      options = options || {};
      for (var option in options) {
        this[option] = options[option];
      }
    }
    util.inherits(FormData2, CombinedStream);
    FormData2.LINE_BREAK = "\r\n";
    FormData2.DEFAULT_CONTENT_TYPE = "application/octet-stream";
    FormData2.prototype.append = function(field, value, options) {
      options = options || {};
      if (typeof options === "string") {
        options = { filename: options };
      }
      var append = CombinedStream.prototype.append.bind(this);
      if (typeof value === "number" || value == null) {
        value = String(value);
      }
      if (Array.isArray(value)) {
        this._error(new Error("Arrays are not supported."));
        return;
      }
      var header = this._multiPartHeader(field, value, options);
      var footer = this._multiPartFooter();
      append(header);
      append(value);
      append(footer);
      this._trackLength(header, value, options);
    };
    FormData2.prototype._trackLength = function(header, value, options) {
      var valueLength = 0;
      if (options.knownLength != null) {
        valueLength += Number(options.knownLength);
      } else if (Buffer.isBuffer(value)) {
        valueLength = value.length;
      } else if (typeof value === "string") {
        valueLength = Buffer.byteLength(value);
      }
      this._valueLength += valueLength;
      this._overheadLength += Buffer.byteLength(header) + FormData2.LINE_BREAK.length;
      if (!value || !value.path && !(value.readable && hasOwn(value, "httpVersion")) && !(value instanceof Stream)) {
        return;
      }
      if (!options.knownLength) {
        this._valuesToMeasure.push(value);
      }
    };
    FormData2.prototype._lengthRetriever = function(value, callback) {
      if (hasOwn(value, "fd")) {
        if (value.end != void 0 && value.end != Infinity && value.start != void 0) {
          callback(null, value.end + 1 - (value.start ? value.start : 0));
        } else {
          fs2.stat(value.path, function(err, stat) {
            if (err) {
              callback(err);
              return;
            }
            var fileSize = stat.size - (value.start ? value.start : 0);
            callback(null, fileSize);
          });
        }
      } else if (hasOwn(value, "httpVersion")) {
        callback(null, Number(value.headers["content-length"]));
      } else if (hasOwn(value, "httpModule")) {
        value.on("response", function(response) {
          value.pause();
          callback(null, Number(response.headers["content-length"]));
        });
        value.resume();
      } else {
        callback("Unknown stream");
      }
    };
    FormData2.prototype._multiPartHeader = function(field, value, options) {
      if (typeof options.header === "string") {
        return options.header;
      }
      var contentDisposition = this._getContentDisposition(value, options);
      var contentType = this._getContentType(value, options);
      var contents = "";
      var headers = {
        // add custom disposition as third element or keep it two elements if not
        "Content-Disposition": ["form-data", 'name="' + escapeHeaderParam(field) + '"'].concat(contentDisposition || []),
        // if no content type. allow it to be empty array
        "Content-Type": [].concat(contentType || [])
      };
      if (typeof options.header === "object") {
        populate(headers, options.header);
      }
      var header;
      for (var prop in headers) {
        if (hasOwn(headers, prop)) {
          header = headers[prop];
          if (header == null) {
            continue;
          }
          if (!Array.isArray(header)) {
            header = [header];
          }
          if (header.length) {
            contents += prop + ": " + header.join("; ") + FormData2.LINE_BREAK;
          }
        }
      }
      return "--" + this.getBoundary() + FormData2.LINE_BREAK + contents + FormData2.LINE_BREAK;
    };
    FormData2.prototype._getContentDisposition = function(value, options) {
      var filename;
      if (typeof options.filepath === "string") {
        filename = path2.normalize(options.filepath).replace(/\\/g, "/");
      } else if (options.filename || value && (value.name || value.path)) {
        filename = path2.basename(options.filename || value && (value.name || value.path));
      } else if (value && value.readable && hasOwn(value, "httpVersion")) {
        filename = path2.basename(value.client._httpMessage.path || "");
      }
      if (filename) {
        return 'filename="' + escapeHeaderParam(filename) + '"';
      }
    };
    FormData2.prototype._getContentType = function(value, options) {
      var contentType = options.contentType;
      if (!contentType && value && value.name) {
        contentType = mime.lookup(value.name);
      }
      if (!contentType && value && value.path) {
        contentType = mime.lookup(value.path);
      }
      if (!contentType && value && value.readable && hasOwn(value, "httpVersion")) {
        contentType = value.headers["content-type"];
      }
      if (!contentType && (options.filepath || options.filename)) {
        contentType = mime.lookup(options.filepath || options.filename);
      }
      if (!contentType && value && typeof value === "object") {
        contentType = FormData2.DEFAULT_CONTENT_TYPE;
      }
      return contentType;
    };
    FormData2.prototype._multiPartFooter = function() {
      return function(next) {
        var footer = FormData2.LINE_BREAK;
        var lastPart = this._streams.length === 0;
        if (lastPart) {
          footer += this._lastBoundary();
        }
        next(footer);
      }.bind(this);
    };
    FormData2.prototype._lastBoundary = function() {
      return "--" + this.getBoundary() + "--" + FormData2.LINE_BREAK;
    };
    FormData2.prototype.getHeaders = function(userHeaders) {
      var header;
      var formHeaders = {
        "content-type": "multipart/form-data; boundary=" + this.getBoundary()
      };
      for (header in userHeaders) {
        if (hasOwn(userHeaders, header)) {
          formHeaders[header.toLowerCase()] = userHeaders[header];
        }
      }
      return formHeaders;
    };
    FormData2.prototype.setBoundary = function(boundary) {
      if (typeof boundary !== "string") {
        throw new TypeError("FormData boundary must be a string");
      }
      this._boundary = boundary;
    };
    FormData2.prototype.getBoundary = function() {
      if (!this._boundary) {
        this._generateBoundary();
      }
      return this._boundary;
    };
    FormData2.prototype.getBuffer = function() {
      var dataBuffer = new Buffer.alloc(0);
      var boundary = this.getBoundary();
      for (var i = 0, len = this._streams.length; i < len; i++) {
        if (typeof this._streams[i] !== "function") {
          if (Buffer.isBuffer(this._streams[i])) {
            dataBuffer = Buffer.concat([dataBuffer, this._streams[i]]);
          } else {
            dataBuffer = Buffer.concat([dataBuffer, Buffer.from(this._streams[i])]);
          }
          if (typeof this._streams[i] !== "string" || this._streams[i].substring(2, boundary.length + 2) !== boundary) {
            dataBuffer = Buffer.concat([dataBuffer, Buffer.from(FormData2.LINE_BREAK)]);
          }
        }
      }
      return Buffer.concat([dataBuffer, Buffer.from(this._lastBoundary())]);
    };
    FormData2.prototype._generateBoundary = function() {
      this._boundary = "--------------------------" + crypto2.randomBytes(12).toString("hex");
    };
    FormData2.prototype.getLengthSync = function() {
      var knownLength = this._overheadLength + this._valueLength;
      if (this._streams.length) {
        knownLength += this._lastBoundary().length;
      }
      if (!this.hasKnownLength()) {
        this._error(new Error("Cannot calculate proper length in synchronous way."));
      }
      return knownLength;
    };
    FormData2.prototype.hasKnownLength = function() {
      var hasKnownLength = true;
      if (this._valuesToMeasure.length) {
        hasKnownLength = false;
      }
      return hasKnownLength;
    };
    FormData2.prototype.getLength = function(cb) {
      var knownLength = this._overheadLength + this._valueLength;
      if (this._streams.length) {
        knownLength += this._lastBoundary().length;
      }
      if (!this._valuesToMeasure.length) {
        process.nextTick(cb.bind(this, null, knownLength));
        return;
      }
      asynckit.parallel(this._valuesToMeasure, this._lengthRetriever, function(err, values) {
        if (err) {
          cb(err);
          return;
        }
        values.forEach(function(length) {
          knownLength += length;
        });
        cb(null, knownLength);
      });
    };
    FormData2.prototype.submit = function(params, cb) {
      var request;
      var options;
      var defaults = { method: "post" };
      if (typeof params === "string") {
        params = parseUrl(params);
        options = populate({
          port: params.port,
          path: params.pathname,
          host: params.hostname,
          protocol: params.protocol
        }, defaults);
      } else {
        options = populate(params, defaults);
        if (!options.port) {
          options.port = options.protocol === "https:" ? 443 : 80;
        }
      }
      options.headers = this.getHeaders(params.headers);
      if (options.protocol === "https:") {
        request = https.request(options);
      } else {
        request = http.request(options);
      }
      this.getLength(function(err, length) {
        if (err && err !== "Unknown stream") {
          this._error(err);
          return;
        }
        if (length) {
          request.setHeader("Content-Length", length);
        }
        this.pipe(request);
        if (cb) {
          var onResponse;
          var callback = function(error, responce) {
            request.removeListener("error", callback);
            request.removeListener("response", onResponse);
            return cb.call(this, error, responce);
          };
          onResponse = callback.bind(this, null);
          request.on("error", callback);
          request.on("response", onResponse);
        }
      }.bind(this));
      return request;
    };
    FormData2.prototype._error = function(err) {
      if (!this.error) {
        this.error = err;
        this.pause();
        this.emit("error", err);
      }
    };
    FormData2.prototype.toString = function() {
      return "[object FormData]";
    };
    setToStringTag(FormData2.prototype, "FormData");
    module2.exports = FormData2;
  }
});

// dependencies/ms/index.js
var require_ms = __commonJS({
  "dependencies/ms/index.js"(exports2, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// dependencies/debug/src/common.js
var require_common = __commonJS({
  "dependencies/debug/src/common.js"(exports2, module2) {
    function setup(env) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env).forEach((key) => {
        createDebug[key] = env[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug(...args) {
          if (!debug.enabled) {
            return;
          }
          const self2 = debug;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self2.diff = ms;
          self2.prev = prevTime;
          self2.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self2, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self2, args);
          const logFn = self2.log || createDebug.log;
          logFn.apply(self2, args);
        }
        debug.namespace = namespace;
        debug.useColors = createDebug.useColors();
        debug.color = createDebug.selectColor(namespace);
        debug.extend = extend;
        debug.destroy = createDebug.destroy;
        Object.defineProperty(debug, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug);
        }
        return debug;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module2.exports = setup;
  }
});

// dependencies/debug/src/browser.js
var require_browser = __commonJS({
  "dependencies/debug/src/browser.js"(exports2, module2) {
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.storage = localstorage();
    exports2.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports2.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports2.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports2.storage.setItem("debug", namespaces);
        } else {
          exports2.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports2.storage.getItem("debug") || exports2.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// dependencies/debug/src/node.js
var require_node = __commonJS({
  "dependencies/debug/src/node.js"(exports2, module2) {
    var tty = require("tty");
    var util = require("util");
    exports2.init = init;
    exports2.log = log;
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports2.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = require("supports-color");
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports2.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports2.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports2.inspectOpts ? Boolean(exports2.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module2.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports2.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports2.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug) {
      debug.inspectOpts = {};
      const keys = Object.keys(exports2.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug.inspectOpts[keys[i]] = exports2.inspectOpts[keys[i]];
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// dependencies/debug/src/index.js
var require_src = __commonJS({
  "dependencies/debug/src/index.js"(exports2, module2) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module2.exports = require_browser();
    } else {
      module2.exports = require_node();
    }
  }
});

// dependencies/agent-base/dist/src/promisify.js
var require_promisify = __commonJS({
  "dependencies/agent-base/dist/src/promisify.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    function promisify(fn) {
      return function(req, opts) {
        return new Promise((resolve, reject) => {
          fn.call(this, req, opts, (err, rtn) => {
            if (err) {
              reject(err);
            } else {
              resolve(rtn);
            }
          });
        });
      };
    }
    exports2.default = promisify;
  }
});

// dependencies/agent-base/dist/src/index.js
var require_src2 = __commonJS({
  "dependencies/agent-base/dist/src/index.js"(exports2, module2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    var events_1 = require("events");
    var debug_1 = __importDefault(require_src());
    var promisify_1 = __importDefault(require_promisify());
    var debug = debug_1.default("agent-base");
    function isAgent(v) {
      return Boolean(v) && typeof v.addRequest === "function";
    }
    function isSecureEndpoint() {
      const { stack } = new Error();
      if (typeof stack !== "string")
        return false;
      return stack.split("\n").some((l) => l.indexOf("(https.js:") !== -1 || l.indexOf("node:https:") !== -1);
    }
    function createAgent(callback, opts) {
      return new createAgent.Agent(callback, opts);
    }
    (function(createAgent2) {
      class Agent extends events_1.EventEmitter {
        constructor(callback, _opts) {
          super();
          let opts = _opts;
          if (typeof callback === "function") {
            this.callback = callback;
          } else if (callback) {
            opts = callback;
          }
          this.timeout = null;
          if (opts && typeof opts.timeout === "number") {
            this.timeout = opts.timeout;
          }
          this.maxFreeSockets = 1;
          this.maxSockets = 1;
          this.maxTotalSockets = Infinity;
          this.sockets = {};
          this.freeSockets = {};
          this.requests = {};
          this.options = {};
        }
        get defaultPort() {
          if (typeof this.explicitDefaultPort === "number") {
            return this.explicitDefaultPort;
          }
          return isSecureEndpoint() ? 443 : 80;
        }
        set defaultPort(v) {
          this.explicitDefaultPort = v;
        }
        get protocol() {
          if (typeof this.explicitProtocol === "string") {
            return this.explicitProtocol;
          }
          return isSecureEndpoint() ? "https:" : "http:";
        }
        set protocol(v) {
          this.explicitProtocol = v;
        }
        callback(req, opts, fn) {
          throw new Error('"agent-base" has no default implementation, you must subclass and override `callback()`');
        }
        /**
         * Called by node-core's "_http_client.js" module when creating
         * a new HTTP request with this Agent instance.
         *
         * @api public
         */
        addRequest(req, _opts) {
          const opts = Object.assign({}, _opts);
          if (typeof opts.secureEndpoint !== "boolean") {
            opts.secureEndpoint = isSecureEndpoint();
          }
          if (opts.host == null) {
            opts.host = "localhost";
          }
          if (opts.port == null) {
            opts.port = opts.secureEndpoint ? 443 : 80;
          }
          if (opts.protocol == null) {
            opts.protocol = opts.secureEndpoint ? "https:" : "http:";
          }
          if (opts.host && opts.path) {
            delete opts.path;
          }
          delete opts.agent;
          delete opts.hostname;
          delete opts._defaultAgent;
          delete opts.defaultPort;
          delete opts.createConnection;
          req._last = true;
          req.shouldKeepAlive = false;
          let timedOut = false;
          let timeoutId = null;
          const timeoutMs = opts.timeout || this.timeout;
          const onerror = (err) => {
            if (req._hadError)
              return;
            req.emit("error", err);
            req._hadError = true;
          };
          const ontimeout = () => {
            timeoutId = null;
            timedOut = true;
            const err = new Error(`A "socket" was not created for HTTP request before ${timeoutMs}ms`);
            err.code = "ETIMEOUT";
            onerror(err);
          };
          const callbackError = (err) => {
            if (timedOut)
              return;
            if (timeoutId !== null) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            onerror(err);
          };
          const onsocket = (socket) => {
            if (timedOut)
              return;
            if (timeoutId != null) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            if (isAgent(socket)) {
              debug("Callback returned another Agent instance %o", socket.constructor.name);
              socket.addRequest(req, opts);
              return;
            }
            if (socket) {
              socket.once("free", () => {
                this.freeSocket(socket, opts);
              });
              req.onSocket(socket);
              return;
            }
            const err = new Error(`no Duplex stream was returned to agent-base for \`${req.method} ${req.path}\``);
            onerror(err);
          };
          if (typeof this.callback !== "function") {
            onerror(new Error("`callback` is not defined"));
            return;
          }
          if (!this.promisifiedCallback) {
            if (this.callback.length >= 3) {
              debug("Converting legacy callback function to promise");
              this.promisifiedCallback = promisify_1.default(this.callback);
            } else {
              this.promisifiedCallback = this.callback;
            }
          }
          if (typeof timeoutMs === "number" && timeoutMs > 0) {
            timeoutId = setTimeout(ontimeout, timeoutMs);
          }
          if ("port" in opts && typeof opts.port !== "number") {
            opts.port = Number(opts.port);
          }
          try {
            debug("Resolving socket for %o request: %o", opts.protocol, `${req.method} ${req.path}`);
            Promise.resolve(this.promisifiedCallback(req, opts)).then(onsocket, callbackError);
          } catch (err) {
            Promise.reject(err).catch(callbackError);
          }
        }
        freeSocket(socket, opts) {
          debug("Freeing socket %o %o", socket.constructor.name, opts);
          socket.destroy();
        }
        destroy() {
          debug("Destroying agent %o", this.constructor.name);
        }
      }
      createAgent2.Agent = Agent;
      createAgent2.prototype = createAgent2.Agent.prototype;
    })(createAgent || (createAgent = {}));
    module2.exports = createAgent;
  }
});

// dependencies/https-proxy-agent/dist/parse-proxy-response.js
var require_parse_proxy_response = __commonJS({
  "dependencies/https-proxy-agent/dist/parse-proxy-response.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var debug_1 = __importDefault(require_src());
    var debug = debug_1.default("https-proxy-agent:parse-proxy-response");
    function parseProxyResponse(socket) {
      return new Promise((resolve, reject) => {
        let buffersLength = 0;
        const buffers = [];
        function read() {
          const b = socket.read();
          if (b)
            ondata(b);
          else
            socket.once("readable", read);
        }
        function cleanup() {
          socket.removeListener("end", onend);
          socket.removeListener("error", onerror);
          socket.removeListener("close", onclose);
          socket.removeListener("readable", read);
        }
        function onclose(err) {
          debug("onclose had error %o", err);
        }
        function onend() {
          debug("onend");
        }
        function onerror(err) {
          cleanup();
          debug("onerror %o", err);
          reject(err);
        }
        function ondata(b) {
          buffers.push(b);
          buffersLength += b.length;
          const buffered = Buffer.concat(buffers, buffersLength);
          const endOfHeaders = buffered.indexOf("\r\n\r\n");
          if (endOfHeaders === -1) {
            debug("have not received end of HTTP headers yet...");
            read();
            return;
          }
          const firstLine = buffered.toString("ascii", 0, buffered.indexOf("\r\n"));
          const statusCode = +firstLine.split(" ")[1];
          debug("got proxy server response: %o", firstLine);
          resolve({
            statusCode,
            buffered
          });
        }
        socket.on("error", onerror);
        socket.on("close", onclose);
        socket.on("end", onend);
        read();
      });
    }
    exports2.default = parseProxyResponse;
  }
});

// dependencies/https-proxy-agent/dist/agent.js
var require_agent = __commonJS({
  "dependencies/https-proxy-agent/dist/agent.js"(exports2) {
    "use strict";
    var __awaiter = exports2 && exports2.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve) {
          resolve(value);
        });
      }
      return new (P || (P = Promise))(function(resolve, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var net_1 = __importDefault(require("net"));
    var tls_1 = __importDefault(require("tls"));
    var url_1 = __importDefault(require("url"));
    var assert_1 = __importDefault(require("assert"));
    var debug_1 = __importDefault(require_src());
    var agent_base_1 = require_src2();
    var parse_proxy_response_1 = __importDefault(require_parse_proxy_response());
    var debug = debug_1.default("https-proxy-agent:agent");
    var HttpsProxyAgent = class extends agent_base_1.Agent {
      constructor(_opts) {
        let opts;
        if (typeof _opts === "string") {
          opts = url_1.default.parse(_opts);
        } else {
          opts = _opts;
        }
        if (!opts) {
          throw new Error("an HTTP(S) proxy server `host` and `port` must be specified!");
        }
        debug("creating new HttpsProxyAgent instance: %o", opts);
        super(opts);
        const proxy = Object.assign({}, opts);
        this.secureProxy = opts.secureProxy || isHTTPS(proxy.protocol);
        proxy.host = proxy.hostname || proxy.host;
        if (typeof proxy.port === "string") {
          proxy.port = parseInt(proxy.port, 10);
        }
        if (!proxy.port && proxy.host) {
          proxy.port = this.secureProxy ? 443 : 80;
        }
        if (this.secureProxy && !("ALPNProtocols" in proxy)) {
          proxy.ALPNProtocols = ["http 1.1"];
        }
        if (proxy.host && proxy.path) {
          delete proxy.path;
          delete proxy.pathname;
        }
        this.proxy = proxy;
      }
      /**
       * Called when the node-core HTTP client library is creating a
       * new HTTP request.
       *
       * @api protected
       */
      callback(req, opts) {
        return __awaiter(this, void 0, void 0, function* () {
          const { proxy, secureProxy } = this;
          let socket;
          if (secureProxy) {
            debug("Creating `tls.Socket`: %o", proxy);
            socket = tls_1.default.connect(proxy);
          } else {
            debug("Creating `net.Socket`: %o", proxy);
            socket = net_1.default.connect(proxy);
          }
          const headers = Object.assign({}, proxy.headers);
          const hostname = `${opts.host}:${opts.port}`;
          let payload = `CONNECT ${hostname} HTTP/1.1\r
`;
          if (proxy.auth) {
            headers["Proxy-Authorization"] = `Basic ${Buffer.from(proxy.auth).toString("base64")}`;
          }
          let { host, port, secureEndpoint } = opts;
          if (!isDefaultPort(port, secureEndpoint)) {
            host += `:${port}`;
          }
          headers.Host = host;
          headers.Connection = "close";
          for (const name of Object.keys(headers)) {
            payload += `${name}: ${headers[name]}\r
`;
          }
          const proxyResponsePromise = parse_proxy_response_1.default(socket);
          socket.write(`${payload}\r
`);
          const { statusCode, buffered } = yield proxyResponsePromise;
          if (statusCode === 200) {
            req.once("socket", resume);
            if (opts.secureEndpoint) {
              debug("Upgrading socket connection to TLS");
              const servername = opts.servername || opts.host;
              return tls_1.default.connect(Object.assign(Object.assign({}, omit(opts, "host", "hostname", "path", "port")), {
                socket,
                servername
              }));
            }
            return socket;
          }
          socket.destroy();
          const fakeSocket = new net_1.default.Socket({ writable: false });
          fakeSocket.readable = true;
          req.once("socket", (s) => {
            debug("replaying proxy buffer for failed request");
            assert_1.default(s.listenerCount("data") > 0);
            s.push(buffered);
            s.push(null);
          });
          return fakeSocket;
        });
      }
    };
    exports2.default = HttpsProxyAgent;
    function resume(socket) {
      socket.resume();
    }
    function isDefaultPort(port, secure) {
      return Boolean(!secure && port === 80 || secure && port === 443);
    }
    function isHTTPS(protocol) {
      return typeof protocol === "string" ? /^https:?$/i.test(protocol) : false;
    }
    function omit(obj, ...keys) {
      const ret = {};
      let key;
      for (key in obj) {
        if (!keys.includes(key)) {
          ret[key] = obj[key];
        }
      }
      return ret;
    }
  }
});

// dependencies/https-proxy-agent/dist/index.js
var require_dist = __commonJS({
  "dependencies/https-proxy-agent/dist/index.js"(exports2, module2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    var agent_1 = __importDefault(require_agent());
    function createHttpsProxyAgent(opts) {
      return new agent_1.default(opts);
    }
    (function(createHttpsProxyAgent2) {
      createHttpsProxyAgent2.HttpsProxyAgent = agent_1.default;
      createHttpsProxyAgent2.prototype = agent_1.default.prototype;
    })(createHttpsProxyAgent || (createHttpsProxyAgent = {}));
    module2.exports = createHttpsProxyAgent;
  }
});

// dependencies/follow-redirects/debug.js
var require_debug = __commonJS({
  "dependencies/follow-redirects/debug.js"(exports2, module2) {
    var debug;
    module2.exports = function() {
      if (!debug) {
        try {
          debug = require_src()("follow-redirects");
        } catch (error) {
        }
        if (typeof debug !== "function") {
          debug = function() {
          };
        }
      }
      debug.apply(null, arguments);
    };
  }
});

// dependencies/follow-redirects/index.js
var require_follow_redirects = __commonJS({
  "dependencies/follow-redirects/index.js"(exports2, module2) {
    var url = require("url");
    var URL3 = url.URL;
    var http = require("http");
    var https = require("https");
    var Writable = require("stream").Writable;
    var assert = require("assert");
    var debug = require_debug();
    (function detectUnsupportedEnvironment() {
      var looksLikeNode = typeof process !== "undefined";
      var looksLikeBrowser = typeof window !== "undefined" && typeof document !== "undefined";
      var looksLikeV8 = isFunction(Error.captureStackTrace);
      if (!looksLikeNode && (looksLikeBrowser || !looksLikeV8)) {
        console.warn("The follow-redirects package should be excluded from browser builds.");
      }
    })();
    var useNativeURL = false;
    try {
      assert(new URL3(""));
    } catch (error) {
      useNativeURL = error.code === "ERR_INVALID_URL";
    }
    var sensitiveHeaders = [
      "Authorization",
      "Proxy-Authorization",
      "Cookie"
    ];
    var preservedUrlFields = [
      "auth",
      "host",
      "hostname",
      "href",
      "path",
      "pathname",
      "port",
      "protocol",
      "query",
      "search",
      "hash"
    ];
    var events = ["abort", "aborted", "connect", "error", "socket", "timeout"];
    var eventHandlers = /* @__PURE__ */ Object.create(null);
    events.forEach(function(event) {
      eventHandlers[event] = function(arg1, arg2, arg3) {
        this._redirectable.emit(event, arg1, arg2, arg3);
      };
    });
    var InvalidUrlError = createErrorType(
      "ERR_INVALID_URL",
      "Invalid URL",
      TypeError
    );
    var RedirectionError = createErrorType(
      "ERR_FR_REDIRECTION_FAILURE",
      "Redirected request failed"
    );
    var TooManyRedirectsError = createErrorType(
      "ERR_FR_TOO_MANY_REDIRECTS",
      "Maximum number of redirects exceeded",
      RedirectionError
    );
    var MaxBodyLengthExceededError = createErrorType(
      "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
      "Request body larger than maxBodyLength limit"
    );
    var WriteAfterEndError = createErrorType(
      "ERR_STREAM_WRITE_AFTER_END",
      "write after end"
    );
    var destroy = Writable.prototype.destroy || noop;
    function RedirectableRequest(options, responseCallback) {
      Writable.call(this);
      this._sanitizeOptions(options);
      this._options = options;
      this._ended = false;
      this._ending = false;
      this._redirectCount = 0;
      this._redirects = [];
      this._requestBodyLength = 0;
      this._requestBodyBuffers = [];
      if (responseCallback) {
        this.on("response", responseCallback);
      }
      var self2 = this;
      this._onNativeResponse = function(response) {
        try {
          self2._processResponse(response);
        } catch (cause) {
          self2.emit("error", cause instanceof RedirectionError ? cause : new RedirectionError({ cause }));
        }
      };
      this._headerFilter = new RegExp("^(?:" + sensitiveHeaders.concat(options.sensitiveHeaders).map(escapeRegex).join("|") + ")$", "i");
      this._performRequest();
    }
    RedirectableRequest.prototype = Object.create(Writable.prototype);
    RedirectableRequest.prototype.abort = function() {
      destroyRequest(this._currentRequest);
      this._currentRequest.abort();
      this.emit("abort");
    };
    RedirectableRequest.prototype.destroy = function(error) {
      destroyRequest(this._currentRequest, error);
      destroy.call(this, error);
      return this;
    };
    RedirectableRequest.prototype.write = function(data, encoding, callback) {
      if (this._ending) {
        throw new WriteAfterEndError();
      }
      if (!isString(data) && !isBuffer(data)) {
        throw new TypeError("data should be a string, Buffer or Uint8Array");
      }
      if (isFunction(encoding)) {
        callback = encoding;
        encoding = null;
      }
      if (data.length === 0) {
        if (callback) {
          callback();
        }
        return;
      }
      if (this._requestBodyLength + data.length <= this._options.maxBodyLength) {
        this._requestBodyLength += data.length;
        this._requestBodyBuffers.push({ data, encoding });
        this._currentRequest.write(data, encoding, callback);
      } else {
        this.emit("error", new MaxBodyLengthExceededError());
        this.abort();
      }
    };
    RedirectableRequest.prototype.end = function(data, encoding, callback) {
      if (isFunction(data)) {
        callback = data;
        data = encoding = null;
      } else if (isFunction(encoding)) {
        callback = encoding;
        encoding = null;
      }
      if (!data) {
        this._ended = this._ending = true;
        this._currentRequest.end(null, null, callback);
      } else {
        var self2 = this;
        var currentRequest = this._currentRequest;
        this.write(data, encoding, function() {
          self2._ended = true;
          currentRequest.end(null, null, callback);
        });
        this._ending = true;
      }
    };
    RedirectableRequest.prototype.setHeader = function(name, value) {
      this._options.headers[name] = value;
      this._currentRequest.setHeader(name, value);
    };
    RedirectableRequest.prototype.removeHeader = function(name) {
      delete this._options.headers[name];
      this._currentRequest.removeHeader(name);
    };
    RedirectableRequest.prototype.setTimeout = function(msecs, callback) {
      var self2 = this;
      function destroyOnTimeout(socket) {
        socket.setTimeout(msecs);
        socket.removeListener("timeout", socket.destroy);
        socket.addListener("timeout", socket.destroy);
      }
      function startTimer(socket) {
        if (self2._timeout) {
          clearTimeout(self2._timeout);
        }
        self2._timeout = setTimeout(function() {
          self2.emit("timeout");
          clearTimer();
        }, msecs);
        destroyOnTimeout(socket);
      }
      function clearTimer() {
        if (self2._timeout) {
          clearTimeout(self2._timeout);
          self2._timeout = null;
        }
        self2.removeListener("abort", clearTimer);
        self2.removeListener("error", clearTimer);
        self2.removeListener("response", clearTimer);
        self2.removeListener("close", clearTimer);
        if (callback) {
          self2.removeListener("timeout", callback);
        }
        if (!self2.socket) {
          self2._currentRequest.removeListener("socket", startTimer);
        }
      }
      if (callback) {
        this.on("timeout", callback);
      }
      if (this.socket) {
        startTimer(this.socket);
      } else {
        this._currentRequest.once("socket", startTimer);
      }
      this.on("socket", destroyOnTimeout);
      this.on("abort", clearTimer);
      this.on("error", clearTimer);
      this.on("response", clearTimer);
      this.on("close", clearTimer);
      return this;
    };
    [
      "flushHeaders",
      "getHeader",
      "setNoDelay",
      "setSocketKeepAlive"
    ].forEach(function(method) {
      RedirectableRequest.prototype[method] = function(a, b) {
        return this._currentRequest[method](a, b);
      };
    });
    ["aborted", "connection", "socket"].forEach(function(property) {
      Object.defineProperty(RedirectableRequest.prototype, property, {
        get: function() {
          return this._currentRequest[property];
        }
      });
    });
    RedirectableRequest.prototype._sanitizeOptions = function(options) {
      if (!options.headers) {
        options.headers = {};
      }
      if (!isArray(options.sensitiveHeaders)) {
        options.sensitiveHeaders = [];
      }
      if (options.host) {
        if (!options.hostname) {
          options.hostname = options.host;
        }
        delete options.host;
      }
      if (!options.pathname && options.path) {
        var searchPos = options.path.indexOf("?");
        if (searchPos < 0) {
          options.pathname = options.path;
        } else {
          options.pathname = options.path.substring(0, searchPos);
          options.search = options.path.substring(searchPos);
        }
      }
    };
    RedirectableRequest.prototype._performRequest = function() {
      var protocol = this._options.protocol;
      var nativeProtocol = this._options.nativeProtocols[protocol];
      if (!nativeProtocol) {
        throw new TypeError("Unsupported protocol " + protocol);
      }
      if (this._options.agents) {
        var scheme = protocol.slice(0, -1);
        this._options.agent = this._options.agents[scheme];
      }
      var request = this._currentRequest = nativeProtocol.request(this._options, this._onNativeResponse);
      request._redirectable = this;
      for (var event of events) {
        request.on(event, eventHandlers[event]);
      }
      this._currentUrl = /^\//.test(this._options.path) ? url.format(this._options) : (
        // When making a request to a proxy, […]
        // a client MUST send the target URI in absolute-form […].
        this._options.path
      );
      if (this._isRedirect) {
        var i = 0;
        var self2 = this;
        var buffers = this._requestBodyBuffers;
        (function writeNext(error) {
          if (request === self2._currentRequest) {
            if (error) {
              self2.emit("error", error);
            } else if (i < buffers.length) {
              var buffer = buffers[i++];
              if (!request.finished) {
                request.write(buffer.data, buffer.encoding, writeNext);
              }
            } else if (self2._ended) {
              request.end();
            }
          }
        })();
      }
    };
    RedirectableRequest.prototype._processResponse = function(response) {
      var statusCode = response.statusCode;
      if (this._options.trackRedirects) {
        this._redirects.push({
          url: this._currentUrl,
          headers: response.headers,
          statusCode
        });
      }
      var location = response.headers.location;
      if (!location || this._options.followRedirects === false || statusCode < 300 || statusCode >= 400) {
        response.responseUrl = this._currentUrl;
        response.redirects = this._redirects;
        this.emit("response", response);
        this._requestBodyBuffers = [];
        return;
      }
      destroyRequest(this._currentRequest);
      response.destroy();
      if (++this._redirectCount > this._options.maxRedirects) {
        throw new TooManyRedirectsError();
      }
      var requestHeaders;
      var beforeRedirect = this._options.beforeRedirect;
      if (beforeRedirect) {
        requestHeaders = Object.assign({
          // The Host header was set by nativeProtocol.request
          Host: response.req.getHeader("host")
        }, this._options.headers);
      }
      var method = this._options.method;
      if ((statusCode === 301 || statusCode === 302) && this._options.method === "POST" || // RFC7231§6.4.4: The 303 (See Other) status code indicates that
      // the server is redirecting the user agent to a different resource […]
      // A user agent can perform a retrieval request targeting that URI
      // (a GET or HEAD request if using HTTP) […]
      statusCode === 303 && !/^(?:GET|HEAD)$/.test(this._options.method)) {
        this._options.method = "GET";
        this._requestBodyBuffers = [];
        removeMatchingHeaders(/^content-/i, this._options.headers);
      }
      var currentHostHeader = removeMatchingHeaders(/^host$/i, this._options.headers);
      var currentUrlParts = parseUrl(this._currentUrl);
      var currentHost = currentHostHeader || currentUrlParts.host;
      var currentUrl = /^\w+:/.test(location) ? this._currentUrl : url.format(Object.assign(currentUrlParts, { host: currentHost }));
      var redirectUrl = resolveUrl(location, currentUrl);
      debug("redirecting to", redirectUrl.href);
      this._isRedirect = true;
      spreadUrlObject(redirectUrl, this._options);
      if (redirectUrl.protocol !== currentUrlParts.protocol && redirectUrl.protocol !== "https:" || redirectUrl.host !== currentHost && !isSubdomain(redirectUrl.host, currentHost)) {
        removeMatchingHeaders(this._headerFilter, this._options.headers);
      }
      if (isFunction(beforeRedirect)) {
        var responseDetails = {
          headers: response.headers,
          statusCode
        };
        var requestDetails = {
          url: currentUrl,
          method,
          headers: requestHeaders
        };
        beforeRedirect(this._options, responseDetails, requestDetails);
        this._sanitizeOptions(this._options);
      }
      this._performRequest();
    };
    function wrap(protocols) {
      var exports3 = {
        maxRedirects: 21,
        maxBodyLength: 10 * 1024 * 1024
      };
      var nativeProtocols = {};
      Object.keys(protocols).forEach(function(scheme) {
        var protocol = scheme + ":";
        var nativeProtocol = nativeProtocols[protocol] = protocols[scheme];
        var wrappedProtocol = exports3[scheme] = Object.create(nativeProtocol);
        function request(input, options, callback) {
          if (isURL(input)) {
            input = spreadUrlObject(input);
          } else if (isString(input)) {
            input = spreadUrlObject(parseUrl(input));
          } else {
            callback = options;
            options = validateUrl(input);
            input = { protocol };
          }
          if (isFunction(options)) {
            callback = options;
            options = null;
          }
          options = Object.assign({
            maxRedirects: exports3.maxRedirects,
            maxBodyLength: exports3.maxBodyLength
          }, input, options);
          options.nativeProtocols = nativeProtocols;
          if (!isString(options.host) && !isString(options.hostname)) {
            options.hostname = "::1";
          }
          assert.equal(options.protocol, protocol, "protocol mismatch");
          debug("options", options);
          return new RedirectableRequest(options, callback);
        }
        function get(input, options, callback) {
          var wrappedRequest = wrappedProtocol.request(input, options, callback);
          wrappedRequest.end();
          return wrappedRequest;
        }
        Object.defineProperties(wrappedProtocol, {
          request: { value: request, configurable: true, enumerable: true, writable: true },
          get: { value: get, configurable: true, enumerable: true, writable: true }
        });
      });
      return exports3;
    }
    function noop() {
    }
    function parseUrl(input) {
      var parsed;
      if (useNativeURL) {
        parsed = new URL3(input);
      } else {
        parsed = validateUrl(url.parse(input));
        if (!isString(parsed.protocol)) {
          throw new InvalidUrlError({ input });
        }
      }
      return parsed;
    }
    function resolveUrl(relative, base) {
      return useNativeURL ? new URL3(relative, base) : parseUrl(url.resolve(base, relative));
    }
    function validateUrl(input) {
      if (/^\[/.test(input.hostname) && !/^\[[:0-9a-f]+\]$/i.test(input.hostname)) {
        throw new InvalidUrlError({ input: input.href || input });
      }
      if (/^\[/.test(input.host) && !/^\[[:0-9a-f]+\](:\d+)?$/i.test(input.host)) {
        throw new InvalidUrlError({ input: input.href || input });
      }
      return input;
    }
    function spreadUrlObject(urlObject, target) {
      var spread = target || {};
      for (var key of preservedUrlFields) {
        spread[key] = urlObject[key];
      }
      if (spread.hostname.startsWith("[")) {
        spread.hostname = spread.hostname.slice(1, -1);
      }
      if (spread.port !== "") {
        spread.port = Number(spread.port);
      }
      spread.path = spread.search ? spread.pathname + spread.search : spread.pathname;
      return spread;
    }
    function removeMatchingHeaders(regex, headers) {
      var lastValue;
      for (var header in headers) {
        if (regex.test(header)) {
          lastValue = headers[header];
          delete headers[header];
        }
      }
      return lastValue === null || typeof lastValue === "undefined" ? void 0 : String(lastValue).trim();
    }
    function createErrorType(code, message, baseClass) {
      function CustomError(properties) {
        if (isFunction(Error.captureStackTrace)) {
          Error.captureStackTrace(this, this.constructor);
        }
        Object.assign(this, properties || {});
        this.code = code;
        this.message = this.cause ? message + ": " + this.cause.message : message;
      }
      CustomError.prototype = new (baseClass || Error)();
      Object.defineProperties(CustomError.prototype, {
        constructor: {
          value: CustomError,
          enumerable: false
        },
        name: {
          value: "Error [" + code + "]",
          enumerable: false
        }
      });
      return CustomError;
    }
    function destroyRequest(request, error) {
      for (var event of events) {
        request.removeListener(event, eventHandlers[event]);
      }
      request.on("error", noop);
      request.destroy(error);
    }
    function isSubdomain(subdomain, domain) {
      assert(isString(subdomain) && isString(domain));
      var dot = subdomain.length - domain.length - 1;
      return dot > 0 && subdomain[dot] === "." && subdomain.endsWith(domain);
    }
    function isArray(value) {
      return value instanceof Array;
    }
    function isString(value) {
      return typeof value === "string" || value instanceof String;
    }
    function isFunction(value) {
      return typeof value === "function";
    }
    function isBuffer(value) {
      return typeof value === "object" && "length" in value;
    }
    function isURL(value) {
      return URL3 && value instanceof URL3;
    }
    function escapeRegex(regex) {
      return regex.replace(/[\]\\/()*+?.$]/g, "\\$&");
    }
    module2.exports = wrap({ http, https });
    module2.exports.wrap = wrap;
  }
});

// dependencies/axios/dist/node/axios.cjs
var require_axios = __commonJS({
  "dependencies/axios/dist/node/axios.cjs"(exports2, module2) {
    "use strict";
    /*! Axios v1.20.0 Copyright (c) 2026 Matt Zabriskie and contributors */
    var FormData$1 = require_form_data();
    var crypto2 = require("crypto");
    var url = require("url");
    var HttpsProxyAgent = require_dist();
    var http = require("http");
    var https = require("https");
    var http2 = require("http2");
    var util = require("util");
    var path2 = require("path");
    var followRedirects = require_follow_redirects();
    var zlib = require("zlib");
    var stream = require("stream");
    var events = require("events");
    function bind(fn, thisArg) {
      return function wrap() {
        return fn.apply(thisArg, arguments);
      };
    }
    var {
      toString
    } = Object.prototype;
    var {
      getPrototypeOf
    } = Object;
    var {
      iterator,
      toStringTag
    } = Symbol;
    var hasOwnProperty = (({
      hasOwnProperty: hasOwnProperty2
    }) => (obj, prop) => hasOwnProperty2.call(obj, prop))(Object.prototype);
    var isUnsafeObjectKey = (prop) => typeof prop === "string" && (prop === "__proto__" || prop === "constructor" || prop === "prototype");
    var isPrototypeBoundary = (obj, prototype2, source) => obj === Object.prototype || !source && prototype2 === null;
    var isSafeAndFullyMutable = (obj) => {
      if (!Object.isExtensible(obj)) {
        return false;
      }
      const props = Object.getOwnPropertyNames(obj);
      if (Object.getOwnPropertySymbols) {
        props.push(...Object.getOwnPropertySymbols(obj));
      }
      return props.every((prop) => {
        if (isUnsafeObjectKey(prop)) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
        return !!descriptor && descriptor.configurable && descriptor.writable === true;
      });
    };
    var hasOwnInPrototypeChain = (thing, prop) => {
      let obj = thing;
      const seen = [];
      while (obj != null) {
        if (seen.indexOf(obj) !== -1) {
          return false;
        }
        seen.push(obj);
        const prototype2 = getPrototypeOf(obj);
        if (isPrototypeBoundary(obj, prototype2, obj === thing)) {
          return false;
        }
        if (hasOwnProperty(obj, prop)) {
          return true;
        }
        obj = prototype2;
      }
      return false;
    };
    var getSafeProp = (obj, prop) => obj != null && hasOwnInPrototypeChain(obj, prop) ? obj[prop] : void 0;
    var toSafeFlatObject = (thing) => {
      if (thing == null || typeof thing !== "object" && typeof thing !== "function") {
        return thing;
      }
      const sourcePrototype = getPrototypeOf(thing);
      if (sourcePrototype === null && isSafeAndFullyMutable(thing)) {
        return thing;
      }
      const result = /* @__PURE__ */ Object.create(null);
      const merged = /* @__PURE__ */ Object.create(null);
      const seen = [];
      let current = thing;
      while (current != null) {
        if (seen.indexOf(current) !== -1) {
          break;
        }
        seen.push(current);
        const prototype2 = current === thing ? sourcePrototype : getPrototypeOf(current);
        if (isPrototypeBoundary(current, prototype2, current === thing)) {
          break;
        }
        const props = Object.getOwnPropertyNames(current);
        if (Object.getOwnPropertySymbols) {
          props.push(...Object.getOwnPropertySymbols(current));
        }
        for (const prop of props) {
          if (isUnsafeObjectKey(prop)) {
            continue;
          }
          if (!hasOwnProperty(merged, prop)) {
            result[prop] = thing[prop];
            merged[prop] = true;
          }
        }
        current = prototype2;
      }
      return result;
    };
    var kindOf = /* @__PURE__ */ ((cache) => (thing) => {
      const str = toString.call(thing);
      return cache[str] || (cache[str] = str.slice(8, -1).toLowerCase());
    })(/* @__PURE__ */ Object.create(null));
    var kindOfTest = (type) => {
      type = type.toLowerCase();
      return (thing) => kindOf(thing) === type;
    };
    var typeOfTest = (type) => (thing) => typeof thing === type;
    var {
      isArray
    } = Array;
    var isUndefined = typeOfTest("undefined");
    function isBuffer(val) {
      return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor) && isFunction$1(val.constructor.isBuffer) && val.constructor.isBuffer(val);
    }
    var isArrayBuffer = kindOfTest("ArrayBuffer");
    function isArrayBufferView(val) {
      let result;
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView) {
        result = ArrayBuffer.isView(val);
      } else {
        result = val && val.buffer && isArrayBuffer(val.buffer);
      }
      return result;
    }
    var isString = typeOfTest("string");
    var isFunction$1 = typeOfTest("function");
    var isNumber = typeOfTest("number");
    var isObject = (thing) => thing !== null && typeof thing === "object";
    var isBoolean = (thing) => thing === true || thing === false;
    var isPlainObject = (val) => {
      if (!isObject(val)) {
        return false;
      }
      const prototype2 = getPrototypeOf(val);
      return (prototype2 === null || prototype2 === Object.prototype || getPrototypeOf(prototype2) === null) && // Treat safe own/inherited Symbol.toStringTag or Symbol.iterator members as
      // evidence the value is tagged/iterable, while ignoring members reachable
      // only through shared or terminal prototype boundaries.
      !hasOwnInPrototypeChain(val, toStringTag) && !hasOwnInPrototypeChain(val, iterator);
    };
    var isEmptyObject = (val) => {
      if (!isObject(val) || isBuffer(val)) {
        return false;
      }
      try {
        return Object.keys(val).length === 0 && Object.getPrototypeOf(val) === Object.prototype;
      } catch (e) {
        return false;
      }
    };
    var isDate = kindOfTest("Date");
    var isFile = kindOfTest("File");
    var isReactNativeBlob = (value) => {
      return !!(value && typeof value.uri !== "undefined");
    };
    var isReactNative = (formData) => formData && typeof formData.getParts !== "undefined";
    var isBlob = kindOfTest("Blob");
    var isFileList = kindOfTest("FileList");
    var isSet = kindOfTest("Set");
    var isStream = (val) => isObject(val) && isFunction$1(val.pipe);
    function getGlobal() {
      if (typeof globalThis !== "undefined") return globalThis;
      if (typeof self !== "undefined") return self;
      if (typeof window !== "undefined") return window;
      if (typeof global !== "undefined") return global;
      return {};
    }
    var G = getGlobal();
    var FormDataCtor = typeof G.FormData !== "undefined" ? G.FormData : void 0;
    var isFormData = (thing) => {
      if (!thing) return false;
      if (FormDataCtor && thing instanceof FormDataCtor) return true;
      const proto = getPrototypeOf(thing);
      if (!proto || proto === Object.prototype) return false;
      if (!isFunction$1(thing.append)) return false;
      const kind = kindOf(thing);
      return kind === "formdata" || // detect form-data instance
      kind === "object" && isFunction$1(thing.toString) && thing.toString() === "[object FormData]";
    };
    var isURLSearchParams = kindOfTest("URLSearchParams");
    var [isReadableStream, isRequest, isResponse, isHeaders] = ["ReadableStream", "Request", "Response", "Headers"].map(kindOfTest);
    var trim = (str) => {
      return str.trim ? str.trim() : str.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");
    };
    function forEach(obj, fn, {
      allOwnKeys = false
    } = {}) {
      if (obj === null || typeof obj === "undefined") {
        return;
      }
      let i;
      let l;
      if (typeof obj !== "object") {
        obj = [obj];
      }
      if (isArray(obj)) {
        for (i = 0, l = obj.length; i < l; i++) {
          fn.call(null, obj[i], i, obj);
        }
      } else {
        if (isBuffer(obj)) {
          return;
        }
        const keys = allOwnKeys ? Object.getOwnPropertyNames(obj) : Object.keys(obj);
        const len = keys.length;
        let key;
        for (i = 0; i < len; i++) {
          key = keys[i];
          fn.call(null, obj[key], key, obj);
        }
      }
    }
    function findKey(obj, key) {
      if (isBuffer(obj)) {
        return null;
      }
      key = key.toLowerCase();
      const keys = Object.keys(obj);
      let i = keys.length;
      let _key;
      while (i-- > 0) {
        _key = keys[i];
        if (key === _key.toLowerCase()) {
          return _key;
        }
      }
      return null;
    }
    var _global = (() => {
      if (typeof globalThis !== "undefined") return globalThis;
      return typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : global;
    })();
    var isContextDefined = (context) => !isUndefined(context) && context !== _global;
    function merge(...objs) {
      const {
        caseless,
        skipUndefined
      } = isContextDefined(this) && this || {};
      const result = {};
      const assignValue = (val, key) => {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          return;
        }
        const targetKey = caseless && typeof key === "string" && findKey(result, key) || key;
        const existing = hasOwnProperty(result, targetKey) ? result[targetKey] : void 0;
        if (isPlainObject(existing) && isPlainObject(val)) {
          result[targetKey] = merge(existing, val);
        } else if (isPlainObject(val)) {
          result[targetKey] = merge({}, val);
        } else if (isArray(val)) {
          result[targetKey] = val.slice();
        } else if (!skipUndefined || !isUndefined(val)) {
          result[targetKey] = val;
        }
      };
      for (let i = 0, l = objs.length; i < l; i++) {
        const source = objs[i];
        if (!source || isBuffer(source)) {
          continue;
        }
        forEach(source, assignValue);
        if (typeof source !== "object" || isArray(source)) {
          continue;
        }
        const symbols = Object.getOwnPropertySymbols(source);
        for (let j = 0; j < symbols.length; j++) {
          const symbol = symbols[j];
          if (propertyIsEnumerable.call(source, symbol)) {
            assignValue(source[symbol], symbol);
          }
        }
      }
      return result;
    }
    var extend = (a, b, thisArg, {
      allOwnKeys
    } = {}) => {
      forEach(b, (val, key) => {
        if (thisArg && isFunction$1(val)) {
          Object.defineProperty(a, key, {
            // Null-proto descriptor so a polluted Object.prototype.get cannot
            // hijack defineProperty's accessor-vs-data resolution.
            __proto__: null,
            value: bind(val, thisArg),
            writable: true,
            enumerable: true,
            configurable: true
          });
        } else {
          Object.defineProperty(a, key, {
            __proto__: null,
            value: val,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }, {
        allOwnKeys
      });
      return a;
    };
    var stripBOM = (content) => {
      if (content.charCodeAt(0) === 65279) {
        content = content.slice(1);
      }
      return content;
    };
    var inherits = (constructor, superConstructor, props, descriptors) => {
      constructor.prototype = Object.create(superConstructor.prototype, descriptors);
      Object.defineProperty(constructor.prototype, "constructor", {
        __proto__: null,
        value: constructor,
        writable: true,
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(constructor, "super", {
        __proto__: null,
        value: superConstructor.prototype
      });
      props && Object.assign(constructor.prototype, props);
    };
    var toFlatObject = (sourceObj, destObj, filter, propFilter) => {
      let props;
      let i;
      let prop;
      const merged = {};
      destObj = destObj || {};
      if (sourceObj == null) return destObj;
      do {
        props = Object.getOwnPropertyNames(sourceObj);
        i = props.length;
        while (i-- > 0) {
          prop = props[i];
          if ((!propFilter || propFilter(prop, sourceObj, destObj)) && !merged[prop]) {
            destObj[prop] = sourceObj[prop];
            merged[prop] = true;
          }
        }
        sourceObj = filter !== false && getPrototypeOf(sourceObj);
      } while (sourceObj && (!filter || filter(sourceObj, destObj)) && sourceObj !== Object.prototype);
      return destObj;
    };
    var endsWith = (str, searchString, position) => {
      str = String(str);
      if (position === void 0 || position > str.length) {
        position = str.length;
      }
      position -= searchString.length;
      const lastIndex = str.indexOf(searchString, position);
      return lastIndex !== -1 && lastIndex === position;
    };
    var toArray = (thing) => {
      if (!thing) return null;
      if (isArray(thing)) return thing;
      let i = thing.length;
      if (!isNumber(i)) return null;
      const arr = new Array(i);
      while (i-- > 0) {
        arr[i] = thing[i];
      }
      return arr;
    };
    var isTypedArray = /* @__PURE__ */ ((TypedArray) => {
      return (thing) => {
        return TypedArray && thing instanceof TypedArray;
      };
    })(typeof Uint8Array !== "undefined" && getPrototypeOf(Uint8Array));
    var forEachEntry = (obj, fn) => {
      const generator = obj && obj[iterator];
      const _iterator = generator.call(obj);
      let result;
      while ((result = _iterator.next()) && !result.done) {
        const pair = result.value;
        fn.call(obj, pair[0], pair[1]);
      }
    };
    var matchAll = (regExp, str) => {
      let matches;
      const arr = [];
      while ((matches = regExp.exec(str)) !== null) {
        arr.push(matches);
      }
      return arr;
    };
    var isHTMLForm = kindOfTest("HTMLFormElement");
    var toCamelCase = (str) => {
      return str.toLowerCase().replace(/[-_\s]([a-z\d])(\w*)/g, function replacer(m, p1, p2) {
        return p1.toUpperCase() + p2;
      });
    };
    var {
      propertyIsEnumerable
    } = Object.prototype;
    var isRegExp = kindOfTest("RegExp");
    var reduceDescriptors = (obj, reducer) => {
      const descriptors = Object.getOwnPropertyDescriptors(obj);
      const reducedDescriptors = {};
      forEach(descriptors, (descriptor, name) => {
        let ret;
        if ((ret = reducer(descriptor, name, obj)) !== false) {
          reducedDescriptors[name] = ret || descriptor;
        }
      });
      Object.defineProperties(obj, reducedDescriptors);
    };
    var freezeMethods = (obj) => {
      reduceDescriptors(obj, (descriptor, name) => {
        if (isFunction$1(obj) && ["arguments", "caller", "callee"].includes(name)) {
          return false;
        }
        const value = obj[name];
        if (!isFunction$1(value)) return;
        descriptor.enumerable = false;
        if ("writable" in descriptor) {
          descriptor.writable = false;
          return;
        }
        if (!descriptor.set) {
          descriptor.set = () => {
            throw Error("Can not rewrite read-only method '" + name + "'");
          };
        }
      });
    };
    var toObjectSet = (arrayOrString, delimiter) => {
      const obj = {};
      const define = (arr) => {
        arr.forEach((value) => {
          obj[value] = true;
        });
      };
      isArray(arrayOrString) ? define(arrayOrString) : define(String(arrayOrString).split(delimiter));
      return obj;
    };
    var noop = () => {
    };
    var toFiniteNumber = (value, defaultValue) => {
      return value != null && Number.isFinite(value = +value) ? value : defaultValue;
    };
    function isSpecCompliantForm(thing) {
      return !!(thing && isFunction$1(thing.append) && thing[toStringTag] === "FormData" && thing[iterator]);
    }
    var toJSONObject = (obj) => {
      const visited = /* @__PURE__ */ new WeakSet();
      const visit = (source) => {
        if (isObject(source)) {
          if (visited.has(source)) {
            return;
          }
          if (isBuffer(source)) {
            return source;
          }
          if (!("toJSON" in source)) {
            visited.add(source);
            let target;
            if (isSet(source)) {
              target = [];
              for (const value of source) {
                const reducedValue = visit(value);
                !isUndefined(reducedValue) && target.push(reducedValue);
              }
            } else {
              target = isArray(source) ? [] : {};
              forEach(source, (value, key) => {
                const reducedValue = visit(value);
                !isUndefined(reducedValue) && (target[key] = reducedValue);
              });
            }
            visited.delete(source);
            return target;
          }
        }
        return source;
      };
      return visit(obj);
    };
    var isAsyncFn = kindOfTest("AsyncFunction");
    var isThenable = (thing) => thing && (isObject(thing) || isFunction$1(thing)) && isFunction$1(thing.then) && isFunction$1(thing.catch);
    var _setImmediate = ((setImmediateSupported, postMessageSupported) => {
      if (setImmediateSupported) {
        return setImmediate;
      }
      return postMessageSupported ? ((token, callbacks) => {
        _global.addEventListener("message", ({
          source,
          data
        }) => {
          if (source === _global && data === token) {
            callbacks.length && callbacks.shift()();
          }
        }, false);
        return (cb) => {
          callbacks.push(cb);
          _global.postMessage(token, "*");
        };
      })(`axios@${Math.random()}`, []) : (cb) => setTimeout(cb);
    })(typeof setImmediate === "function", isFunction$1(_global.postMessage));
    var asap = typeof queueMicrotask !== "undefined" ? queueMicrotask.bind(_global) : typeof process !== "undefined" && process.nextTick || _setImmediate;
    var isIterable = (thing) => thing != null && isFunction$1(thing[iterator]);
    var isSafeIterable = (thing) => thing != null && hasOwnInPrototypeChain(thing, iterator) && isIterable(thing);
    var utils$1 = {
      isArray,
      isArrayBuffer,
      isBuffer,
      isFormData,
      isArrayBufferView,
      isString,
      isNumber,
      isBoolean,
      isObject,
      isPlainObject,
      isEmptyObject,
      isReadableStream,
      isRequest,
      isResponse,
      isHeaders,
      isUndefined,
      isDate,
      isFile,
      isReactNativeBlob,
      isReactNative,
      isBlob,
      isRegExp,
      isFunction: isFunction$1,
      isStream,
      isURLSearchParams,
      isTypedArray,
      isFileList,
      forEach,
      merge,
      extend,
      trim,
      stripBOM,
      inherits,
      toFlatObject,
      kindOf,
      kindOfTest,
      endsWith,
      toArray,
      forEachEntry,
      matchAll,
      isHTMLForm,
      hasOwnProperty,
      hasOwnProp: hasOwnProperty,
      // an alias to avoid ESLint no-prototype-builtins detection
      hasOwnInPrototypeChain,
      getSafeProp,
      toSafeFlatObject,
      reduceDescriptors,
      freezeMethods,
      toObjectSet,
      toCamelCase,
      noop,
      toFiniteNumber,
      findKey,
      global: _global,
      isContextDefined,
      isSpecCompliantForm,
      toJSONObject,
      isAsyncFn,
      isThenable,
      setImmediate: _setImmediate,
      asap,
      isIterable,
      isSafeIterable
    };
    var ignoreDuplicateOf = utils$1.toObjectSet(["age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "user-agent"]);
    var parseHeaders = (rawHeaders) => {
      const parsed = {};
      let key;
      let val;
      let i;
      rawHeaders && rawHeaders.split("\n").forEach(function parser(line) {
        i = line.indexOf(":");
        key = line.substring(0, i).trim().toLowerCase();
        val = line.substring(i + 1).trim();
        const hasKey = utils$1.hasOwnProp(parsed, key);
        if (!key || hasKey && utils$1.hasOwnProp(ignoreDuplicateOf, key)) {
          return;
        }
        if (key === "set-cookie") {
          if (hasKey) {
            parsed[key].push(val);
          } else {
            parsed[key] = [val];
          }
        } else {
          parsed[key] = hasKey ? parsed[key] + ", " + val : val;
        }
      });
      return parsed;
    };
    function trimSPorHTAB(str) {
      let start = 0;
      let end = str.length;
      while (start < end) {
        const code = str.charCodeAt(start);
        if (code !== 9 && code !== 32) {
          break;
        }
        start += 1;
      }
      while (end > start) {
        const code = str.charCodeAt(end - 1);
        if (code !== 9 && code !== 32) {
          break;
        }
        end -= 1;
      }
      return start === 0 && end === str.length ? str : str.slice(start, end);
    }
    var INVALID_UNICODE_HEADER_VALUE_CHARS = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f]+", "g");
    var INVALID_BYTE_STRING_HEADER_VALUE_CHARS = new RegExp("[^\\u0009\\u0020-\\u007e\\u0080-\\u00ff]+", "g");
    function sanitizeValue(value, invalidChars) {
      if (utils$1.isArray(value)) {
        return value.map((item) => sanitizeValue(item, invalidChars));
      }
      return trimSPorHTAB(String(value).replace(invalidChars, ""));
    }
    var sanitizeHeaderValue = (value) => sanitizeValue(value, INVALID_UNICODE_HEADER_VALUE_CHARS);
    var sanitizeByteStringHeaderValue = (value) => sanitizeValue(value, INVALID_BYTE_STRING_HEADER_VALUE_CHARS);
    function toByteStringHeaderObject(headers) {
      const byteStringHeaders = /* @__PURE__ */ Object.create(null);
      utils$1.forEach(headers.toJSON(), (value, header) => {
        byteStringHeaders[header] = sanitizeByteStringHeaderValue(value);
      });
      return byteStringHeaders;
    }
    var $internals$1 = /* @__PURE__ */ Symbol("internals");
    function normalizeHeader(header) {
      return header && String(header).trim().toLowerCase();
    }
    function normalizeValue(value) {
      if (value === false || value == null) {
        return value;
      }
      return utils$1.isArray(value) ? value.map(normalizeValue) : sanitizeHeaderValue(String(value));
    }
    function parseTokens(str) {
      const tokens = /* @__PURE__ */ Object.create(null);
      const tokensRE = /([^\s,;=]+)\s*(?:=\s*([^,;]+))?/g;
      let match;
      while (match = tokensRE.exec(str)) {
        tokens[match[1]] = match[2];
      }
      return tokens;
    }
    var parameterNameRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function trimOWS(value) {
      let start = 0;
      let end = value.length;
      while (start < end) {
        const code = value.charCodeAt(start);
        if (code !== 9 && code !== 32) {
          break;
        }
        start += 1;
      }
      while (end > start) {
        const code = value.charCodeAt(end - 1);
        if (code !== 9 && code !== 32) {
          break;
        }
        end -= 1;
      }
      return start === 0 && end === value.length ? value : value.slice(start, end);
    }
    function decodeQuotedString(value) {
      const last = value.length - 1;
      if (last < 1 || value.charCodeAt(0) !== 34 || value.charCodeAt(last) !== 34) {
        return value;
      }
      let decoded = "";
      for (let i = 1; i < last; i++) {
        const code = value.charCodeAt(i);
        if (code === 34) {
          return value;
        }
        if (code === 92) {
          i += 1;
          if (i >= last) {
            return value;
          }
        }
        decoded += value[i];
      }
      return decoded;
    }
    function parseParameters(value) {
      const parameters = /* @__PURE__ */ Object.create(null);
      const str = String(value);
      let start = 0;
      let quoted = false;
      let escaped = false;
      function parseParameter(end) {
        const part = trimOWS(str.slice(start, end));
        const equals = part.indexOf("=");
        if (equals < 1) {
          return;
        }
        const name = trimOWS(part.slice(0, equals));
        if (!parameterNameRE.test(name)) {
          return;
        }
        const normalizedName = name.toLowerCase();
        if (normalizedName === "__proto__" || normalizedName === "constructor" || normalizedName === "prototype") {
          return;
        }
        const parameterValue = trimOWS(part.slice(equals + 1));
        parameters[normalizedName] = decodeQuotedString(parameterValue);
      }
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (quoted) {
          if (escaped) {
            escaped = false;
          } else if (code === 92) {
            escaped = true;
          } else if (code === 34) {
            quoted = false;
          }
        } else if (code === 34) {
          quoted = true;
        } else if (code === 44 || code === 59) {
          parseParameter(i);
          start = i + 1;
        }
      }
      parseParameter(str.length);
      return parameters;
    }
    var isValidHeaderName = (str) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(str.trim());
    function matchHeaderValue(context, value, header, filter, isHeaderNameFilter) {
      if (utils$1.isFunction(filter)) {
        return filter.call(this, value, header);
      }
      if (isHeaderNameFilter) {
        value = header;
      }
      if (!utils$1.isString(value)) return;
      if (utils$1.isString(filter)) {
        return value.indexOf(filter) !== -1;
      }
      if (utils$1.isRegExp(filter)) {
        return filter.test(value);
      }
    }
    function formatHeader(header) {
      return header.trim().toLowerCase().replace(/([a-z\d])(\w*)/g, (w, char, str) => {
        return char.toUpperCase() + str;
      });
    }
    function buildAccessors(obj, header) {
      const accessorName = utils$1.toCamelCase(" " + header);
      ["get", "set", "has"].forEach((methodName) => {
        Object.defineProperty(obj, methodName + accessorName, {
          // Null-proto descriptor so a polluted Object.prototype.get cannot turn
          // this data descriptor into an accessor descriptor on the way in.
          __proto__: null,
          value: function(arg1, arg2, arg3) {
            return this[methodName].call(this, header, arg1, arg2, arg3);
          },
          configurable: true
        });
      });
    }
    var AxiosHeaders = class {
      constructor(headers) {
        headers && this.set(headers);
      }
      set(header, valueOrRewrite, rewrite) {
        const self2 = this;
        function setHeader(_value, _header, _rewrite) {
          const lHeader = normalizeHeader(_header);
          if (!lHeader) {
            return;
          }
          const key = utils$1.findKey(self2, lHeader);
          if (!key || self2[key] === void 0 || _rewrite === true || _rewrite === void 0 && self2[key] !== false) {
            self2[key || _header] = normalizeValue(_value);
          }
        }
        const setHeaders = (headers, _rewrite) => utils$1.forEach(headers, (_value, _header) => setHeader(_value, _header, _rewrite));
        if (utils$1.isPlainObject(header) || header instanceof this.constructor) {
          setHeaders(header, valueOrRewrite);
        } else if (utils$1.isString(header) && (header = header.trim()) && !isValidHeaderName(header)) {
          setHeaders(parseHeaders(header), valueOrRewrite);
        } else if (utils$1.isObject(header) && utils$1.isSafeIterable(header)) {
          let obj = /* @__PURE__ */ Object.create(null), dest, key;
          for (const entry of header) {
            if (!utils$1.isArray(entry)) {
              throw new TypeError("Object iterator must return a key-value pair");
            }
            key = entry[0];
            if (utils$1.hasOwnProp(obj, key)) {
              dest = obj[key];
              obj[key] = utils$1.isArray(dest) ? [...dest, entry[1]] : [dest, entry[1]];
            } else {
              obj[key] = entry[1];
            }
          }
          setHeaders(obj, valueOrRewrite);
        } else {
          header != null && setHeader(valueOrRewrite, header, rewrite);
        }
        return this;
      }
      get(header, parser) {
        header = normalizeHeader(header);
        if (header) {
          const key = utils$1.findKey(this, header);
          if (key) {
            const value = this[key];
            if (!parser) {
              return value;
            }
            if (parser === true) {
              return parseTokens(value);
            }
            if (utils$1.isFunction(parser)) {
              return parser.call(this, value, key);
            }
            if (utils$1.isRegExp(parser)) {
              return parser.exec(value);
            }
            throw new TypeError("parser must be boolean|regexp|function");
          }
        }
      }
      has(header, matcher) {
        header = normalizeHeader(header);
        if (header) {
          const key = utils$1.findKey(this, header);
          return !!(key && this[key] !== void 0 && (!matcher || matchHeaderValue(this, this[key], key, matcher)));
        }
        return false;
      }
      delete(header, matcher) {
        const self2 = this;
        let deleted = false;
        function deleteHeader(_header) {
          _header = normalizeHeader(_header);
          if (_header) {
            const key = utils$1.findKey(self2, _header);
            if (key && (!matcher || matchHeaderValue(self2, self2[key], key, matcher))) {
              delete self2[key];
              deleted = true;
            }
          }
        }
        if (utils$1.isArray(header)) {
          header.forEach(deleteHeader);
        } else {
          deleteHeader(header);
        }
        return deleted;
      }
      clear(matcher) {
        const keys = Object.keys(this);
        let i = keys.length;
        let deleted = false;
        while (i--) {
          const key = keys[i];
          if (!matcher || matchHeaderValue(this, this[key], key, matcher, true)) {
            delete this[key];
            deleted = true;
          }
        }
        return deleted;
      }
      normalize(format) {
        const self2 = this;
        const headers = {};
        utils$1.forEach(this, (value, header) => {
          const key = utils$1.findKey(headers, header);
          if (key) {
            self2[key] = normalizeValue(value);
            delete self2[header];
            return;
          }
          const normalized = format ? formatHeader(header) : String(header).trim();
          if (normalized !== header) {
            delete self2[header];
          }
          self2[normalized] = normalizeValue(value);
          headers[normalized] = true;
        });
        return this;
      }
      concat(...targets) {
        return this.constructor.concat(this, ...targets);
      }
      toJSON(asStrings) {
        const obj = /* @__PURE__ */ Object.create(null);
        utils$1.forEach(this, (value, header) => {
          value != null && value !== false && (obj[header] = asStrings && utils$1.isArray(value) ? value.join(", ") : value);
        });
        return obj;
      }
      [Symbol.iterator]() {
        return Object.entries(this.toJSON())[Symbol.iterator]();
      }
      toString() {
        return Object.entries(this.toJSON()).map(([header, value]) => header + ": " + value).join("\n");
      }
      getSetCookie() {
        const value = this.get("set-cookie");
        return utils$1.isArray(value) ? value : value == null || value === false ? [] : [value];
      }
      get [Symbol.toStringTag]() {
        return "AxiosHeaders";
      }
      static from(thing) {
        return thing instanceof this ? thing : new this(thing);
      }
      static parseParameters(value) {
        return parseParameters(value);
      }
      static concat(first, ...targets) {
        const computed = new this(first);
        targets.forEach((target) => computed.set(target));
        return computed;
      }
      static accessor(header) {
        const internals = this[$internals$1] = this[$internals$1] = {
          accessors: {}
        };
        const accessors = internals.accessors;
        const prototype2 = this.prototype;
        function defineAccessor(_header) {
          const lHeader = normalizeHeader(_header);
          if (!accessors[lHeader]) {
            buildAccessors(prototype2, _header);
            accessors[lHeader] = true;
          }
        }
        utils$1.isArray(header) ? header.forEach(defineAccessor) : defineAccessor(header);
        return this;
      }
    };
    AxiosHeaders.accessor(["Content-Type", "Content-Length", "Accept", "Accept-Encoding", "User-Agent", "Authorization"]);
    utils$1.reduceDescriptors(AxiosHeaders.prototype, ({
      value
    }, key) => {
      let mapped = key[0].toUpperCase() + key.slice(1);
      return {
        get: () => value,
        set(headerValue) {
          this[mapped] = headerValue;
        }
      };
    });
    utils$1.freezeMethods(AxiosHeaders);
    var REDACTED = "[REDACTED ****]";
    function hasOwnOrPrototypeToJSON(source) {
      if (utils$1.hasOwnProp(source, "toJSON")) {
        return true;
      }
      let prototype2 = Object.getPrototypeOf(source);
      while (prototype2 && prototype2 !== Object.prototype) {
        if (utils$1.hasOwnProp(prototype2, "toJSON")) {
          return true;
        }
        prototype2 = Object.getPrototypeOf(prototype2);
      }
      return false;
    }
    function redactConfig(config, redactKeys) {
      const lowerKeys = new Set(redactKeys.map((k) => String(k).toLowerCase()));
      const seen = [];
      const visit = (source) => {
        if (source === null || typeof source !== "object") return source;
        if (utils$1.isBuffer(source)) return source;
        if (seen.indexOf(source) !== -1) return void 0;
        if (source instanceof AxiosHeaders) {
          source = source.toJSON();
        }
        seen.push(source);
        let result;
        if (utils$1.isArray(source)) {
          result = [];
          source.forEach((v, i) => {
            const reducedValue = visit(v);
            if (!utils$1.isUndefined(reducedValue)) {
              result[i] = reducedValue;
            }
          });
        } else {
          if (!utils$1.isPlainObject(source) && hasOwnOrPrototypeToJSON(source)) {
            seen.pop();
            return source;
          }
          result = /* @__PURE__ */ Object.create(null);
          for (const [key, value] of Object.entries(source)) {
            const reducedValue = lowerKeys.has(key.toLowerCase()) ? REDACTED : visit(value);
            if (!utils$1.isUndefined(reducedValue)) {
              result[key] = reducedValue;
            }
          }
        }
        seen.pop();
        return result;
      };
      return visit(config);
    }
    function stringifySafely$1(value) {
      try {
        return String(value);
      } catch (err) {
        return "";
      }
    }
    function aggregateErrorMessage(error) {
      const message = error.errors.map((entry) => {
        try {
          return entry && entry.message ? stringifySafely$1(entry.message) : stringifySafely$1(entry);
        } catch (err) {
          return "";
        }
      }).filter(Boolean).join("; ");
      return message || error.name || "AggregateError";
    }
    var AxiosError = class _AxiosError extends Error {
      static from(error, code, config, request, response, customProps) {
        let message = error.message;
        if (!message && utils$1.isArray(error.errors) && error.errors.length) {
          message = aggregateErrorMessage(error);
        }
        const axiosError = new _AxiosError(message, code || error.code, config, request, response);
        Object.defineProperty(axiosError, "cause", {
          __proto__: null,
          value: error,
          writable: true,
          enumerable: false,
          configurable: true
        });
        axiosError.name = error.name;
        if (error.status != null && axiosError.status == null) {
          axiosError.status = error.status;
        }
        customProps && Object.assign(axiosError, customProps);
        return axiosError;
      }
      /**
       * Create an Error with the specified message, config, error code, request and response.
       *
       * @param {string} message The error message.
       * @param {string} [code] The error code (for example, 'ECONNABORTED').
       * @param {Object} [config] The config.
       * @param {Object} [request] The request.
       * @param {Object} [response] The response.
       *
       * @returns {Error} The created error.
       */
      constructor(message, code, config, request, response) {
        super(message);
        Object.defineProperty(this, "message", {
          // Null-proto descriptor so a polluted Object.prototype.get cannot turn
          // this data descriptor into an accessor descriptor on the way in.
          __proto__: null,
          value: message,
          enumerable: true,
          writable: true,
          configurable: true
        });
        this.name = "AxiosError";
        this.isAxiosError = true;
        code && (this.code = code);
        config && (this.config = config);
        request && (this.request = request);
        if (response) {
          this.response = response;
          this.status = response.status;
        }
      }
      toJSON() {
        const config = this.config;
        const redactKeys = config && utils$1.hasOwnProp(config, "redact") ? config.redact : void 0;
        const serializedConfig = utils$1.isArray(redactKeys) && redactKeys.length > 0 ? redactConfig(config, redactKeys) : utils$1.toJSONObject(config);
        return {
          // Standard
          message: this.message,
          name: this.name,
          // Microsoft
          description: this.description,
          number: this.number,
          // Mozilla
          fileName: this.fileName,
          lineNumber: this.lineNumber,
          columnNumber: this.columnNumber,
          stack: this.stack,
          // Axios
          config: serializedConfig,
          code: this.code,
          status: this.status
        };
      }
    };
    AxiosError.ERR_BAD_OPTION_VALUE = "ERR_BAD_OPTION_VALUE";
    AxiosError.ERR_BAD_OPTION = "ERR_BAD_OPTION";
    AxiosError.ECONNABORTED = "ECONNABORTED";
    AxiosError.ETIMEDOUT = "ETIMEDOUT";
    AxiosError.ECONNREFUSED = "ECONNREFUSED";
    AxiosError.ERR_NETWORK = "ERR_NETWORK";
    AxiosError.ERR_FR_TOO_MANY_REDIRECTS = "ERR_FR_TOO_MANY_REDIRECTS";
    AxiosError.ERR_DEPRECATED = "ERR_DEPRECATED";
    AxiosError.ERR_BAD_RESPONSE = "ERR_BAD_RESPONSE";
    AxiosError.ERR_BAD_REQUEST = "ERR_BAD_REQUEST";
    AxiosError.ERR_CANCELED = "ERR_CANCELED";
    AxiosError.ERR_NOT_SUPPORT = "ERR_NOT_SUPPORT";
    AxiosError.ERR_INVALID_URL = "ERR_INVALID_URL";
    AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED = "ERR_FORM_DATA_DEPTH_EXCEEDED";
    var PlatformBuffer = {
      isBufferAvailable() {
        return typeof Buffer !== "undefined";
      },
      from(value) {
        return Buffer.from(value);
      }
    };
    var DEFAULT_FORM_DATA_MAX_DEPTH = 100;
    function isVisitable(thing) {
      return utils$1.isPlainObject(thing) || utils$1.isArray(thing);
    }
    function removeBrackets(key) {
      return utils$1.endsWith(key, "[]") ? key.slice(0, -2) : key;
    }
    function renderKey(path3, key, dots) {
      if (!path3) return key;
      return path3.concat(key).map(function each(token, i) {
        token = removeBrackets(token);
        return !dots && i ? "[" + token + "]" : token;
      }).join(dots ? "." : "");
    }
    function isFlatArray(arr) {
      return utils$1.isArray(arr) && !arr.some(isVisitable);
    }
    var predicates = utils$1.toFlatObject(utils$1, {}, null, function filter(prop) {
      return /^is[A-Z]/.test(prop);
    });
    function toFormData(obj, formData, options) {
      if (!utils$1.isObject(obj)) {
        throw new TypeError("target must be an object");
      }
      formData = formData || new (FormData$1 || FormData)();
      const option = (name, fallback) => {
        const value = utils$1.getSafeProp(options, name);
        return utils$1.isUndefined(value) ? fallback : value;
      };
      const metaTokens = option("metaTokens", true);
      const visitor = option("visitor") || defaultVisitor;
      const dots = option("dots", false);
      const indexes = option("indexes", false);
      const _Blob = option("Blob") || typeof Blob !== "undefined" && Blob;
      const maxDepth = option("maxDepth", DEFAULT_FORM_DATA_MAX_DEPTH);
      const useBlob = _Blob && utils$1.isSpecCompliantForm(formData);
      const stack = [];
      if (!utils$1.isFunction(visitor)) {
        throw new TypeError("visitor must be a function");
      }
      function convertValue(value) {
        if (value === null) return "";
        if (utils$1.isDate(value)) {
          return value.toISOString();
        }
        if (utils$1.isBoolean(value)) {
          return value.toString();
        }
        if (!useBlob && utils$1.isBlob(value)) {
          throw new AxiosError("Blob is not supported. Use a Buffer instead.");
        }
        if (utils$1.isArrayBuffer(value) || utils$1.isTypedArray(value)) {
          if (useBlob && typeof _Blob === "function") {
            return new _Blob([value]);
          }
          if (PlatformBuffer && PlatformBuffer.isBufferAvailable()) {
            return PlatformBuffer.from(value);
          }
          throw new AxiosError("Blob is not supported. Use a Buffer instead.", AxiosError.ERR_NOT_SUPPORT);
        }
        return value;
      }
      function throwIfMaxDepthExceeded(depth) {
        if (depth > maxDepth) {
          throw new AxiosError("Object is too deeply nested (" + depth + " levels). Max depth: " + maxDepth, AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED);
        }
      }
      function stringifyWithDepthLimit(value, depth) {
        if (maxDepth === Infinity) {
          return JSON.stringify(value);
        }
        const ancestors = [];
        return JSON.stringify(value, function limitDepth(_key, currentValue) {
          if (!utils$1.isObject(currentValue)) {
            return currentValue;
          }
          while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
            ancestors.pop();
          }
          ancestors.push(currentValue);
          throwIfMaxDepthExceeded(depth + ancestors.length - 1);
          return currentValue;
        });
      }
      function defaultVisitor(value, key, path3) {
        let arr = value;
        if (utils$1.isReactNative(formData) && utils$1.isReactNativeBlob(value)) {
          formData.append(renderKey(path3, key, dots), convertValue(value));
          return false;
        }
        if (value && !path3 && typeof value === "object") {
          if (utils$1.endsWith(key, "{}")) {
            key = metaTokens ? key : key.slice(0, -2);
            value = stringifyWithDepthLimit(value, 1);
          } else if (utils$1.isArray(value) && isFlatArray(value) || (utils$1.isFileList(value) || utils$1.endsWith(key, "[]")) && (arr = utils$1.toArray(value))) {
            key = removeBrackets(key);
            arr.forEach(function each(el, index) {
              !(utils$1.isUndefined(el) || el === null) && formData.append(
                // eslint-disable-next-line no-nested-ternary
                indexes === true ? renderKey([key], index, dots) : indexes === null ? key : key + "[]",
                convertValue(el)
              );
            });
            return false;
          }
        }
        if (isVisitable(value)) {
          return true;
        }
        formData.append(renderKey(path3, key, dots), convertValue(value));
        return false;
      }
      const exposedHelpers = Object.assign(predicates, {
        defaultVisitor,
        convertValue,
        isVisitable
      });
      function build(value, path3, depth = 0) {
        if (utils$1.isUndefined(value)) return;
        throwIfMaxDepthExceeded(depth);
        if (stack.indexOf(value) !== -1) {
          throw new Error("Circular reference detected in " + path3.join("."));
        }
        stack.push(value);
        utils$1.forEach(value, function each(el, key) {
          const result = !(utils$1.isUndefined(el) || el === null) && visitor.call(formData, el, utils$1.isString(key) ? key.trim() : key, path3, exposedHelpers);
          if (result === true) {
            build(el, path3 ? path3.concat(key) : [key], depth + 1);
          }
        });
        stack.pop();
      }
      if (!utils$1.isObject(obj)) {
        throw new TypeError("data must be an object");
      }
      build(obj);
      return formData;
    }
    function encode$1(str) {
      const charMap = {
        "!": "%21",
        "'": "%27",
        "(": "%28",
        ")": "%29",
        "~": "%7E",
        "%20": "+"
      };
      return encodeURIComponent(str).replace(/[!'()~]|%20/g, function replacer(match) {
        return charMap[match];
      });
    }
    function AxiosURLSearchParams(params, options) {
      this._pairs = [];
      params && toFormData(params, this, options);
    }
    var prototype = AxiosURLSearchParams.prototype;
    prototype.append = function append(name, value) {
      this._pairs.push([name, value]);
    };
    prototype.toString = function toString2(encoder) {
      const _encode = encoder ? (value) => encoder.call(this, value, encode$1) : encode$1;
      return this._pairs.map(function each(pair) {
        return _encode(pair[0]) + "=" + _encode(pair[1]);
      }, "").join("&");
    };
    function encode(val) {
      return encodeURIComponent(val).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
    }
    function buildURL(url2, params, options) {
      if (!params) {
        return url2;
      }
      url2 = url2 || "";
      const _options = utils$1.isFunction(options) ? {
        serialize: options
      } : options;
      const _encode = utils$1.getSafeProp(_options, "encode") || encode;
      const serializeFn = utils$1.getSafeProp(_options, "serialize");
      let serializedParams;
      if (serializeFn) {
        serializedParams = serializeFn(params, _options);
      } else {
        serializedParams = utils$1.isURLSearchParams(params) ? params.toString() : new AxiosURLSearchParams(params, _options).toString(_encode);
      }
      if (serializedParams) {
        const hashmarkIndex = url2.indexOf("#");
        if (hashmarkIndex !== -1) {
          url2 = url2.slice(0, hashmarkIndex);
        }
        url2 += (url2.indexOf("?") === -1 ? "?" : "&") + serializedParams;
      }
      return url2;
    }
    var $internals = /* @__PURE__ */ Symbol("internals");
    function countHandlers(handlers) {
      return handlers ? handlers.length : 0;
    }
    function trimHandlers(handlers) {
      if (!handlers) {
        return;
      }
      while (handlers.length && handlers[handlers.length - 1] === null) {
        handlers.pop();
      }
    }
    function syncHandlerEntries(manager, internals) {
      const handlers = manager.handlers;
      const length = countHandlers(handlers);
      if (handlers !== internals.handlersRef) {
        internals.handlersRef = handlers;
        internals.handlerEntries.clear();
      } else if (length !== internals.handlersLength) {
        if (!length) {
          internals.handlerEntries.clear();
        } else {
          internals.handlerEntries.forEach(function removeStaleEntry(entry, id) {
            if (handlers[entry.index] !== entry.handler) {
              internals.handlerEntries.delete(id);
            }
          });
        }
      }
      internals.handlersLength = length;
    }
    var InterceptorManager = class {
      constructor() {
        this.handlers = [];
        this[$internals] = {
          handlersRef: this.handlers,
          handlersLength: this.handlers.length,
          handlerEntries: /* @__PURE__ */ new Map(),
          iterationDepth: 0,
          nextId: 0
        };
      }
      /**
       * Add a new interceptor to the stack
       *
       * @param {Function} fulfilled The function to handle `then` for a `Promise`
       * @param {Function} rejected The function to handle `reject` for a `Promise`
       * @param {Object} options The options for the interceptor, synchronous and runWhen
       *
       * @return {Number} An ID used to remove interceptor later
       */
      use(fulfilled, rejected, options) {
        const handler = {
          fulfilled,
          rejected,
          synchronous: options ? options.synchronous : false,
          runWhen: options ? options.runWhen : null
        };
        const internals = this[$internals];
        if (this.handlers == null) {
          this.handlers = [];
        }
        syncHandlerEntries(this, internals);
        const id = internals.nextId++;
        this.handlers.push(handler);
        internals.handlerEntries.set(id, {
          handler,
          index: this.handlers.length - 1
        });
        internals.handlersLength = this.handlers.length;
        return id;
      }
      /**
       * Remove an interceptor from the stack
       *
       * @param {Number} id The ID that was returned by `use`
       *
       * @returns {void}
       */
      eject(id) {
        const internals = this[$internals];
        syncHandlerEntries(this, internals);
        const entry = internals.handlerEntries.get(id);
        if (entry) {
          internals.handlerEntries.delete(id);
          if (this.handlers[entry.index] !== entry.handler) {
            return;
          }
          this.handlers[entry.index] = null;
          if (!internals.iterationDepth) {
            trimHandlers(this.handlers);
            internals.handlersLength = this.handlers.length;
          }
        }
      }
      /**
       * Clear all interceptors from the stack
       *
       * @returns {void}
       */
      clear() {
        if (this.handlers) {
          this.handlers = [];
          syncHandlerEntries(this, this[$internals]);
        }
      }
      /**
       * Iterate over all the registered interceptors
       *
       * This method is particularly useful for skipping over any
       * interceptors that may have become `null` calling `eject`.
       *
       * @param {Function} fn The function to call for each interceptor
       *
       * @returns {void}
       */
      forEach(fn) {
        const internals = this[$internals];
        syncHandlerEntries(this, internals);
        internals.iterationDepth++;
        try {
          utils$1.forEach(this.handlers, function forEachHandler(h) {
            if (h !== null) {
              fn(h);
            }
          });
        } finally {
          if (!--internals.iterationDepth) {
            syncHandlerEntries(this, internals);
            trimHandlers(this.handlers);
            internals.handlersLength = countHandlers(this.handlers);
          }
        }
      }
    };
    var transitionalDefaults = {
      silentJSONParsing: true,
      forcedJSONParsing: true,
      clarifyTimeoutError: false,
      legacyInterceptorReqResOrdering: true,
      advertiseZstdAcceptEncoding: false,
      validateStatusUndefinedResolves: true
    };
    var URLSearchParams = url.URLSearchParams;
    var ALPHA = "abcdefghijklmnopqrstuvwxyz";
    var DIGIT = "0123456789";
    var ALPHABET = {
      DIGIT,
      ALPHA,
      ALPHA_DIGIT: ALPHA + ALPHA.toUpperCase() + DIGIT
    };
    var generateString = (size = 16, alphabet = ALPHABET.ALPHA_DIGIT) => {
      let str = "";
      const {
        length
      } = alphabet;
      const randomValues = new Uint32Array(size);
      crypto2.randomFillSync(randomValues);
      for (let i = 0; i < size; i++) {
        str += alphabet[randomValues[i] % length];
      }
      return str;
    };
    var platform$1 = {
      isNode: true,
      classes: {
        URLSearchParams,
        FormData: FormData$1,
        Blob: typeof Blob !== "undefined" && Blob || null
      },
      ALPHABET,
      generateString,
      protocols: ["http", "https", "file", "data"]
    };
    var hasBrowserEnv = typeof window !== "undefined" && typeof document !== "undefined";
    var _navigator = typeof navigator === "object" && navigator || void 0;
    var hasStandardBrowserEnv = hasBrowserEnv && (!_navigator || ["ReactNative", "NativeScript", "NS"].indexOf(_navigator.product) < 0);
    var hasStandardBrowserWebWorkerEnv = (() => {
      return typeof WorkerGlobalScope !== "undefined" && // eslint-disable-next-line no-undef
      self instanceof WorkerGlobalScope && typeof self.importScripts === "function";
    })();
    var origin = hasBrowserEnv && window.location.href || "http://localhost";
    var utils = /* @__PURE__ */ Object.freeze({
      __proto__: null,
      hasBrowserEnv,
      hasStandardBrowserEnv,
      hasStandardBrowserWebWorkerEnv,
      navigator: _navigator,
      origin
    });
    var platform = {
      ...utils,
      ...platform$1
    };
    function toURLEncodedForm(data, options) {
      return toFormData(data, new platform.classes.URLSearchParams(), {
        visitor: function(value, key, path3, helpers) {
          if (platform.isNode && utils$1.isBuffer(value)) {
            this.append(key, value.toString("base64"));
            return false;
          }
          return helpers.defaultVisitor.apply(this, arguments);
        },
        ...options
      });
    }
    var MAX_DEPTH = DEFAULT_FORM_DATA_MAX_DEPTH;
    function throwIfDepthExceeded(index) {
      if (index > MAX_DEPTH) {
        throw new AxiosError("FormData field is too deeply nested (" + index + " levels). Max depth: " + MAX_DEPTH, AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED);
      }
    }
    function parsePropPath(name) {
      const path3 = [];
      const pattern = /[^.[\]]+|\[([^.[\]]*)]/g;
      let match;
      while ((match = pattern.exec(name)) !== null) {
        throwIfDepthExceeded(path3.length);
        path3.push(match[0] === "[]" ? "" : match[1] || match[0]);
      }
      return path3;
    }
    function arrayToObject(arr) {
      const obj = {};
      const keys = Object.keys(arr);
      let i;
      const len = keys.length;
      let key;
      for (i = 0; i < len; i++) {
        key = keys[i];
        obj[key] = arr[key];
      }
      return obj;
    }
    function formDataToJSON(formData) {
      function buildPath(path3, value, target, index) {
        throwIfDepthExceeded(index);
        let name = path3[index++];
        if (name === "__proto__") return true;
        const isNumericKey = Number.isFinite(+name);
        const isLast = index >= path3.length;
        name = !name && utils$1.isArray(target) ? target.length : name;
        if (isLast) {
          if (utils$1.hasOwnProp(target, name)) {
            target[name] = utils$1.isArray(target[name]) ? target[name].concat(value) : [target[name], value];
          } else {
            target[name] = value;
          }
          return !isNumericKey;
        }
        if (!utils$1.hasOwnProp(target, name) || !utils$1.isObject(target[name])) {
          target[name] = [];
        }
        const result = buildPath(path3, value, target[name], index);
        if (result && utils$1.isArray(target[name])) {
          target[name] = arrayToObject(target[name]);
        }
        return !isNumericKey;
      }
      if (utils$1.isFormData(formData) && utils$1.isFunction(formData.entries)) {
        const obj = {};
        utils$1.forEachEntry(formData, (name, value) => {
          buildPath(parsePropPath(name), value, obj, 0);
        });
        return obj;
      }
      return null;
    }
    var methodList = Object.freeze(["get", "delete", "head", "options", "post", "put", "patch", "purge", "link", "unlink", "query"]);
    var own = (obj, key) => obj != null && utils$1.hasOwnProp(obj, key) ? obj[key] : void 0;
    function stringifySafely(rawValue, parser, encoder) {
      if (utils$1.isString(rawValue)) {
        try {
          (parser || JSON.parse)(rawValue);
          return utils$1.trim(rawValue);
        } catch (e) {
          if (e.name !== "SyntaxError") {
            throw e;
          }
        }
      }
      return (encoder || JSON.stringify)(rawValue);
    }
    var defaults = {
      transitional: transitionalDefaults,
      adapter: ["xhr", "http", "fetch"],
      transformRequest: [function transformRequest(data, headers) {
        const contentType = headers.getContentType() || "";
        const hasJSONContentType = contentType.indexOf("application/json") > -1;
        const isObjectPayload = utils$1.isObject(data);
        if (isObjectPayload && utils$1.isHTMLForm(data)) {
          data = new FormData(data);
        }
        const isFormData2 = utils$1.isFormData(data);
        if (isFormData2) {
          return hasJSONContentType ? JSON.stringify(formDataToJSON(data)) : data;
        }
        if (utils$1.isArrayBuffer(data) || utils$1.isBuffer(data) || utils$1.isStream(data) || utils$1.isFile(data) || utils$1.isBlob(data) || utils$1.isReadableStream(data)) {
          return data;
        }
        if (utils$1.isArrayBufferView(data)) {
          return data.buffer;
        }
        if (utils$1.isURLSearchParams(data)) {
          headers.setContentType("application/x-www-form-urlencoded;charset=utf-8", false);
          return data.toString();
        }
        let isFileList2;
        if (isObjectPayload) {
          const formSerializer = own(this, "formSerializer");
          if (contentType.indexOf("application/x-www-form-urlencoded") > -1) {
            return toURLEncodedForm(data, formSerializer).toString();
          }
          if ((isFileList2 = utils$1.isFileList(data)) || contentType.indexOf("multipart/form-data") > -1) {
            const env = own(this, "env");
            const _FormData = env && env.FormData;
            return toFormData(isFileList2 ? {
              "files[]": data
            } : data, _FormData && new _FormData(), formSerializer);
          }
        }
        if (isObjectPayload || hasJSONContentType) {
          headers.setContentType("application/json", false);
          return stringifySafely(data);
        }
        return data;
      }],
      transformResponse: [function transformResponse(data) {
        const transitional = own(this, "transitional") || defaults.transitional;
        const forcedJSONParsing = transitional && transitional.forcedJSONParsing;
        const responseType = own(this, "responseType");
        const JSONRequested = responseType === "json";
        if (utils$1.isResponse(data) || utils$1.isReadableStream(data)) {
          return data;
        }
        if (data && utils$1.isString(data) && (forcedJSONParsing && !responseType || JSONRequested)) {
          const silentJSONParsing = transitional && transitional.silentJSONParsing;
          const strictJSONParsing = !silentJSONParsing && JSONRequested;
          try {
            return JSON.parse(data, own(this, "parseReviver"));
          } catch (e) {
            if (strictJSONParsing) {
              if (e.name === "SyntaxError") {
                throw AxiosError.from(e, AxiosError.ERR_BAD_RESPONSE, this, null, own(this, "response"));
              }
              throw e;
            }
          }
        }
        return data;
      }],
      /**
       * A timeout in milliseconds to abort a request. If set to 0 (default) a
       * timeout is not created.
       */
      timeout: 0,
      xsrfCookieName: "XSRF-TOKEN",
      xsrfHeaderName: "X-XSRF-TOKEN",
      maxContentLength: -1,
      maxBodyLength: -1,
      env: {
        FormData: platform.classes.FormData,
        Blob: platform.classes.Blob
      },
      validateStatus: function validateStatus(status) {
        return status >= 200 && status < 300;
      },
      headers: {
        common: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": void 0
        }
      }
    };
    utils$1.forEach(methodList, (method) => {
      defaults.headers[method] = {};
    });
    function transformData(fns, response) {
      const config = this || defaults;
      const context = response || config;
      const headers = AxiosHeaders.from(context.headers);
      let data = context.data;
      utils$1.forEach(fns, function transform(fn) {
        data = fn.call(config, data, headers.normalize(), response ? response.status : void 0);
      });
      headers.normalize();
      return data;
    }
    function isCancel(value) {
      return !!(value && value.__CANCEL__);
    }
    var CanceledError = class extends AxiosError {
      /**
       * A `CanceledError` is an object that is thrown when an operation is canceled.
       *
       * @param {string=} message The message.
       * @param {Object=} config The config.
       * @param {Object=} request The request.
       *
       * @returns {CanceledError} The created error.
       */
      constructor(message, config, request) {
        super(message == null ? "canceled" : message, AxiosError.ERR_CANCELED, config, request);
        this.name = "CanceledError";
        this.__CANCEL__ = true;
      }
    };
    function settle(resolve, reject, response) {
      const validateStatus = response.config.validateStatus;
      if (!response.status || !validateStatus || validateStatus(response.status)) {
        resolve(response);
      } else {
        reject(new AxiosError("Request failed with status code " + response.status, response.status >= 400 && response.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE, response.config, response.request, response));
      }
    }
    function isAbsoluteURL(url2) {
      if (typeof url2 !== "string") {
        return false;
      }
      return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url2);
    }
    function combineURLs(baseURL, relativeURL) {
      if (!relativeURL) {
        return baseURL;
      }
      let end = baseURL.length;
      while (end > 0 && baseURL.charCodeAt(end - 1) === 47) {
        end--;
      }
      return baseURL.slice(0, end) + "/" + relativeURL.replace(/^\/+/, "");
    }
    var urlParserControlCharacters = /[\t\n\r]/g;
    function normalizeURLForProtocolCheck(url2) {
      if (typeof url2 !== "string") {
        return url2;
      }
      let start = 0;
      while (start < url2.length && url2.charCodeAt(start) <= 32) {
        start++;
      }
      return url2.slice(start).replace(urlParserControlCharacters, "");
    }
    var malformedHttpProtocol = /^https?:(?!\/\/)/i;
    function redactFragment(fragment) {
      if (!fragment) {
        return fragment;
      }
      return fragment.replace(/(^|&)([^=&]*=)?[^&]+/g, (match, separator, parameterName = "") => {
        return `${separator}${parameterName}${REDACTED}`;
      });
    }
    function redactSensitiveURLParts(url2) {
      const redactedURL = url2.replace(/^(https?:\/{0,2})[^/?#]*@/i, `$1${REDACTED}@`);
      const fragmentIndex = redactedURL.indexOf("#");
      const urlWithoutFragment = fragmentIndex === -1 ? redactedURL : redactedURL.slice(0, fragmentIndex);
      const redactedURLWithoutFragment = urlWithoutFragment.replace(/([?&][^=&#]*=)[^&#]*/g, `$1${REDACTED}`);
      if (fragmentIndex === -1) {
        return redactedURLWithoutFragment;
      }
      return `${redactedURLWithoutFragment}#${redactFragment(redactedURL.slice(fragmentIndex + 1))}`;
    }
    function assertValidHttpProtocolURL(url2, config) {
      if (typeof url2 === "string") {
        const normalizedURL = normalizeURLForProtocolCheck(url2);
        if (malformedHttpProtocol.test(normalizedURL)) {
          throw new AxiosError(`Invalid URL ${JSON.stringify(redactSensitiveURLParts(normalizedURL))}: missing "//" after protocol`, AxiosError.ERR_INVALID_URL, config);
        }
      }
    }
    function buildFullPath(baseURL, requestedURL, allowAbsoluteUrls, config) {
      assertValidHttpProtocolURL(requestedURL, config);
      let isRelativeUrl = !isAbsoluteURL(requestedURL);
      if (baseURL && (isRelativeUrl || allowAbsoluteUrls === false)) {
        assertValidHttpProtocolURL(baseURL, config);
        return combineURLs(baseURL, requestedURL);
      }
      return requestedURL;
    }
    var DEFAULT_PORTS$1 = {
      ftp: 21,
      gopher: 70,
      http: 80,
      https: 443,
      ws: 80,
      wss: 443
    };
    function parseUrl(urlString) {
      try {
        return new URL(urlString);
      } catch {
        return null;
      }
    }
    function getProxyForUrl(url2) {
      var parsedUrl = (typeof url2 === "string" ? parseUrl(url2) : url2) || {};
      var proto = parsedUrl.protocol;
      var hostname = parsedUrl.host;
      var port = parsedUrl.port;
      if (typeof hostname !== "string" || !hostname || typeof proto !== "string") {
        return "";
      }
      proto = proto.split(":", 1)[0];
      hostname = hostname.replace(/:\d*$/, "");
      port = parseInt(port) || DEFAULT_PORTS$1[proto] || 0;
      if (!shouldProxy(hostname, port)) {
        return "";
      }
      var proxy = getEnv(proto + "_proxy") || getEnv("all_proxy");
      if (proxy && proxy.indexOf("://") === -1) {
        proxy = proto + "://" + proxy;
      }
      return proxy;
    }
    function shouldProxy(hostname, port) {
      var NO_PROXY = getEnv("no_proxy").toLowerCase();
      if (!NO_PROXY) {
        return true;
      }
      if (NO_PROXY === "*") {
        return false;
      }
      return NO_PROXY.split(/[,\s]/).every(function(proxy) {
        if (!proxy) {
          return true;
        }
        var parsedProxy = proxy.match(/^(.+):(\d+)$/);
        var parsedProxyHostname = parsedProxy ? parsedProxy[1] : proxy;
        var parsedProxyPort = parsedProxy ? parseInt(parsedProxy[2]) : 0;
        if (parsedProxyPort && parsedProxyPort !== port) {
          return true;
        }
        if (!/^[.*]/.test(parsedProxyHostname)) {
          return hostname !== parsedProxyHostname;
        }
        if (parsedProxyHostname.charAt(0) === "*") {
          parsedProxyHostname = parsedProxyHostname.slice(1);
        }
        return !hostname.endsWith(parsedProxyHostname);
      });
    }
    function getEnv(key) {
      return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || "";
    }
    var VERSION = "1.20.0";
    function parseProtocol(url2) {
      const match = /^([-+\w]{1,25}):(?:\/\/)?/.exec(url2);
      return match && match[1] || "";
    }
    var DATA_URL_PATTERN = /^([^,;/]+\/[^,;/]+)?((?:;[^,;=]+=[^,;]+)*)(;base64)?,([\s\S]*)$/;
    function fromDataURI(uri, asBlob, options) {
      const _Blob = options && options.Blob || platform.classes.Blob;
      const protocol = parseProtocol(uri);
      if (asBlob === void 0 && _Blob) {
        asBlob = true;
      }
      if (protocol === "data") {
        uri = protocol.length ? uri.slice(protocol.length + 1) : uri;
        const match = DATA_URL_PATTERN.exec(uri);
        if (!match) {
          throw new AxiosError("Invalid URL", AxiosError.ERR_INVALID_URL);
        }
        const type = match[1];
        const params = match[2];
        const encoding = match[3] ? "base64" : "utf8";
        const body = match[4];
        let mime = "";
        if (type) {
          mime = params ? type + params : type;
        } else if (params) {
          mime = "text/plain" + params;
        }
        const buffer = encoding === "base64" ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), encoding);
        if (asBlob) {
          if (!_Blob) {
            throw new AxiosError("Blob is not supported", AxiosError.ERR_NOT_SUPPORT);
          }
          return new _Blob([buffer], {
            type: mime
          });
        }
        return buffer;
      }
      throw new AxiosError("Unsupported protocol " + protocol, AxiosError.ERR_NOT_SUPPORT);
    }
    var FORM_DATA_CONTENT_HEADERS = ["content-type", "content-length"];
    function setFormDataHeaders(headers, formHeaders, policy) {
      if (policy !== "content-only") {
        headers.set(formHeaders);
        return;
      }
      Object.entries(formHeaders || {}).forEach(([key, val]) => {
        if (FORM_DATA_CONTENT_HEADERS.includes(key.toLowerCase())) {
          headers.set(key, val);
        }
      });
    }
    var kInternals = /* @__PURE__ */ Symbol("internals");
    var AxiosTransformStream = class extends stream.Transform {
      constructor(options) {
        options = utils$1.toFlatObject(options, {
          maxRate: 0,
          chunkSize: 64 * 1024,
          minChunkSize: 100,
          timeWindow: 500,
          ticksRate: 2,
          samplesCount: 15
        }, null, (prop, source) => {
          return !utils$1.isUndefined(source[prop]);
        });
        super({
          readableHighWaterMark: options.chunkSize
        });
        const internals = this[kInternals] = {
          timeWindow: options.timeWindow,
          chunkSize: options.chunkSize,
          maxRate: options.maxRate,
          minChunkSize: options.minChunkSize,
          bytesSeen: 0,
          isCaptured: false,
          notifiedBytesLoaded: 0,
          ts: Date.now(),
          bytes: 0,
          onReadCallback: null
        };
        this.on("newListener", (event) => {
          if (event === "progress") {
            if (!internals.isCaptured) {
              internals.isCaptured = true;
            }
          }
        });
      }
      _read(size) {
        const internals = this[kInternals];
        if (internals.onReadCallback) {
          internals.onReadCallback();
        }
        return super._read(size);
      }
      _transform(chunk, encoding, callback) {
        const internals = this[kInternals];
        const maxRate = internals.maxRate;
        const readableHighWaterMark = this.readableHighWaterMark;
        const timeWindow = internals.timeWindow;
        const divider = 1e3 / timeWindow;
        const bytesThreshold = maxRate / divider;
        const minChunkSize = internals.minChunkSize !== false ? Math.max(internals.minChunkSize, bytesThreshold * 0.01) : 0;
        const pushChunk = (_chunk, _callback) => {
          const bytes = Buffer.byteLength(_chunk);
          internals.bytesSeen += bytes;
          internals.bytes += bytes;
          internals.isCaptured && this.emit("progress", internals.bytesSeen);
          if (this.push(_chunk)) {
            process.nextTick(_callback);
          } else {
            internals.onReadCallback = () => {
              internals.onReadCallback = null;
              process.nextTick(_callback);
            };
          }
        };
        const transformChunk = (_chunk, _callback) => {
          const chunkSize = Buffer.byteLength(_chunk);
          let chunkRemainder = null;
          let maxChunkSize = readableHighWaterMark;
          let bytesLeft;
          let passed = 0;
          if (maxRate) {
            const now = Date.now();
            if (!internals.ts || (passed = now - internals.ts) >= timeWindow) {
              internals.ts = now;
              bytesLeft = bytesThreshold - internals.bytes;
              internals.bytes = bytesLeft < 0 ? -bytesLeft : 0;
              passed = 0;
            }
            bytesLeft = bytesThreshold - internals.bytes;
          }
          if (maxRate) {
            if (bytesLeft <= 0) {
              return setTimeout(() => {
                _callback(null, _chunk);
              }, timeWindow - passed);
            }
            if (bytesLeft < maxChunkSize) {
              maxChunkSize = bytesLeft;
            }
          }
          if (maxChunkSize && chunkSize > maxChunkSize && chunkSize - maxChunkSize > minChunkSize) {
            chunkRemainder = _chunk.subarray(maxChunkSize);
            _chunk = _chunk.subarray(0, maxChunkSize);
          }
          pushChunk(_chunk, chunkRemainder ? () => {
            process.nextTick(_callback, null, chunkRemainder);
          } : _callback);
        };
        transformChunk(chunk, function transformNextChunk(err, _chunk) {
          if (err) {
            return callback(err);
          }
          if (_chunk) {
            transformChunk(_chunk, transformNextChunk);
          } else {
            callback(null);
          }
        });
      }
    };
    var {
      asyncIterator
    } = Symbol;
    var readBlob = async function* (blob) {
      if (blob.stream) {
        yield* blob.stream();
      } else if (blob.arrayBuffer) {
        yield await blob.arrayBuffer();
      } else if (blob[asyncIterator]) {
        yield* blob[asyncIterator]();
      } else {
        yield blob;
      }
    };
    var BOUNDARY_ALPHABET = platform.ALPHABET.ALPHA_DIGIT + "-_";
    var textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : new util.TextEncoder();
    var CRLF = "\r\n";
    var CRLF_BYTES = textEncoder.encode(CRLF);
    var CRLF_BYTES_COUNT = 2;
    var FormDataPart = class {
      constructor(name, value) {
        const {
          escapeName
        } = this.constructor;
        const isStringValue = utils$1.isString(value);
        let headers = `Content-Disposition: form-data; name="${escapeName(name)}"${!isStringValue && value.name ? `; filename="${escapeName(value.name)}"` : ""}${CRLF}`;
        if (isStringValue) {
          value = textEncoder.encode(String(value).replace(/\r?\n|\r\n?/g, CRLF));
        } else {
          const safeType = String(value.type || "application/octet-stream").replace(/[\r\n]/g, "");
          headers += `Content-Type: ${safeType}${CRLF}`;
        }
        this.headers = textEncoder.encode(headers + CRLF);
        this.contentLength = isStringValue ? value.byteLength : value.size;
        this.size = this.headers.byteLength + this.contentLength + CRLF_BYTES_COUNT;
        this.name = name;
        this.value = value;
      }
      async *encode() {
        yield this.headers;
        const {
          value
        } = this;
        if (utils$1.isTypedArray(value)) {
          yield value;
        } else {
          yield* readBlob(value);
        }
        yield CRLF_BYTES;
      }
      static escapeName(name) {
        return String(name).replace(/[\r\n"]/g, (match) => ({
          "\r": "%0D",
          "\n": "%0A",
          '"': "%22"
        })[match]);
      }
    };
    var formDataToStream = (form, headersHandler, options) => {
      const {
        tag = "form-data-boundary",
        size = 25,
        boundary = tag + "-" + platform.generateString(size, BOUNDARY_ALPHABET)
      } = options || {};
      if (!utils$1.isFormData(form)) {
        throw new TypeError("FormData instance required");
      }
      if (boundary.length < 1 || boundary.length > 70) {
        throw new Error("boundary must be 1-70 characters long");
      }
      const boundaryBytes = textEncoder.encode("--" + boundary + CRLF);
      const footerBytes = textEncoder.encode("--" + boundary + "--" + CRLF);
      let contentLength = footerBytes.byteLength;
      const parts = Array.from(form.entries()).map(([name, value]) => {
        const part = new FormDataPart(name, value);
        contentLength += part.size;
        return part;
      });
      contentLength += boundaryBytes.byteLength * parts.length;
      contentLength = utils$1.toFiniteNumber(contentLength);
      const computedHeaders = {
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      };
      if (Number.isFinite(contentLength)) {
        computedHeaders["Content-Length"] = contentLength;
      }
      headersHandler && headersHandler(computedHeaders);
      return stream.Readable.from((async function* () {
        for (const part of parts) {
          yield boundaryBytes;
          yield* part.encode();
        }
        yield footerBytes;
      })());
    };
    var ZlibHeaderTransformStream = class extends stream.Transform {
      __transform(chunk, encoding, callback) {
        this.push(chunk);
        callback();
      }
      _transform(chunk, encoding, callback) {
        if (chunk.length !== 0) {
          this._transform = this.__transform;
          if (chunk[0] !== 120) {
            const header = Buffer.alloc(2);
            header[0] = 120;
            header[1] = 156;
            this.push(header, encoding);
          }
        }
        this.__transform(chunk, encoding, callback);
      }
    };
    var Http2Sessions = class {
      constructor() {
        this.sessions = /* @__PURE__ */ Object.create(null);
      }
      getSession(authority, options) {
        options = Object.assign(/* @__PURE__ */ Object.create(null), {
          sessionTimeout: 1e3
        }, options);
        let authoritySessions = this.sessions[authority];
        if (authoritySessions) {
          let len = authoritySessions.length;
          for (let i = 0; i < len; i++) {
            const [sessionHandle, sessionOptions] = authoritySessions[i];
            if (!sessionHandle.destroyed && !sessionHandle.closed && util.isDeepStrictEqual(sessionOptions, options)) {
              return sessionHandle;
            }
          }
        }
        const session = http2.connect(authority, options);
        let removed;
        let timer;
        const removeSession = () => {
          if (removed) {
            return;
          }
          removed = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          let entries = authoritySessions, len = entries.length, i = len;
          while (i--) {
            if (entries[i][0] === session) {
              if (len === 1) {
                delete this.sessions[authority];
              } else {
                entries.splice(i, 1);
              }
              if (!session.closed) {
                session.close();
              }
              return;
            }
          }
        };
        const originalRequestFn = session.request;
        const {
          sessionTimeout
        } = options;
        if (sessionTimeout != null) {
          let streamsCount = 0;
          session.request = function() {
            const stream2 = originalRequestFn.apply(this, arguments);
            streamsCount++;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            stream2.once("close", () => {
              if (!--streamsCount) {
                timer = setTimeout(() => {
                  timer = null;
                  removeSession();
                }, sessionTimeout);
              }
            });
            return stream2;
          };
        }
        session.once("close", removeSession);
        session.once("error", removeSession);
        let entry = [session, options];
        authoritySessions ? authoritySessions.push(entry) : authoritySessions = this.sessions[authority] = [entry];
        return session;
      }
    };
    var callbackify = (fn, reducer) => {
      return utils$1.isAsyncFn(fn) ? function(...args) {
        const cb = args.pop();
        fn.apply(this, args).then((value) => {
          try {
            reducer ? cb(null, ...reducer(value)) : cb(null, value);
          } catch (err) {
            cb(err);
          }
        }, cb);
      } : fn;
    };
    var LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "0.0.0.0"]);
    var trimTrailingDots = (value) => {
      let end = value.length;
      while (end && value.charCodeAt(end - 1) === 46) {
        end--;
      }
      return end === value.length ? value : value.slice(0, end);
    };
    var isIPv4Loopback = (host) => {
      const parts = host.split(".");
      if (parts.length !== 4) return false;
      if (parts[0] !== "127") return false;
      return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
    };
    var parseIPv4Octet = (text) => {
      if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
        const n = parseInt(text.slice(2), 16);
        return Number.isFinite(n) ? n : null;
      }
      if (text.length > 1 && /^0[0-7]+$/.test(text)) {
        const n = parseInt(text, 8);
        return Number.isFinite(n) ? n : null;
      }
      if (text.length > 1 && /^0[0-9]+$/.test(text)) {
        return null;
      }
      if (/^[0-9]+$/.test(text)) {
        const n = parseInt(text, 10);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    var normalizeIPAddress = (host) => {
      if (typeof host !== "string" || !host || host.indexOf(":") !== -1) {
        return host;
      }
      let h = host;
      if (h.charAt(0) === "[" && h.charAt(h.length - 1) === "]") {
        h = h.slice(1, -1);
      }
      h = trimTrailingDots(h);
      if (!/^[0-9.xXa-fA-F]+$/.test(h)) return host;
      const parts = h.split(".");
      if (parts.some((p) => p === "")) return host;
      if (parts.length === 4) {
        const octets = parts.map(parseIPv4Octet);
        if (octets.some((n) => n === null || n < 0 || n > 255)) return host;
        return octets.join(".");
      }
      if (parts.length > 4) {
        return host;
      }
      if (parts.length === 1) return host;
      const literalOctets = parts.slice(0, -1);
      const tail = parts[parts.length - 1];
      const tailSlots = 4 - literalOctets.length;
      const tailValue = parseIPv4Octet(tail);
      if (tailValue === null) return host;
      const maxTail = (1 << 8 * tailSlots) - 1;
      if (tailValue < 0 || tailValue > maxTail) return host;
      const tailOctets = new Array(tailSlots).fill(0);
      for (let i = tailSlots - 1, v = tailValue; i >= 0; i--, v >>= 8) {
        tailOctets[i] = v & 255;
      }
      const literal = literalOctets.map(parseIPv4Octet);
      if (literal.some((n) => n === null || n < 0 || n > 255)) return host;
      return [...literal, ...tailOctets].join(".");
    };
    var isIPv6ZeroGroup = (group) => /^0{1,4}$/.test(group);
    var isIPv6Unspecified = (host) => {
      if (host === "::") return true;
      const compressionIndex = host.indexOf("::");
      if (compressionIndex !== -1) {
        if (compressionIndex !== host.lastIndexOf("::")) return false;
        const left = host.slice(0, compressionIndex);
        const right = host.slice(compressionIndex + 2);
        const leftGroups = left ? left.split(":") : [];
        const rightGroups = right ? right.split(":") : [];
        const explicitGroups = leftGroups.length + rightGroups.length;
        return explicitGroups < 8 && leftGroups.every(isIPv6ZeroGroup) && rightGroups.every(isIPv6ZeroGroup);
      }
      const groups = host.split(":");
      return groups.length === 8 && groups.every(isIPv6ZeroGroup);
    };
    var isIPv6Loopback = (host) => {
      if (host === "::1") return true;
      const v4MappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (v4MappedDotted) return isIPv4Loopback(v4MappedDotted[1]);
      const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (v4MappedHex) {
        const high = parseInt(v4MappedHex[1], 16);
        return high >= 32512 && high <= 32767;
      }
      const groups = host.split(":");
      if (groups.length === 8) {
        for (let i = 0; i < 7; i++) {
          if (!/^0+$/.test(groups[i])) return false;
        }
        return /^0*1$/.test(groups[7]);
      }
      return false;
    };
    var isLoopback = (host) => {
      if (!host) return false;
      if (LOOPBACK_HOSTNAMES.has(host)) return true;
      if (isIPv4Loopback(host)) return true;
      if (isIPv6Unspecified(host)) return true;
      return isIPv6Loopback(host);
    };
    var DEFAULT_PORTS = {
      http: 80,
      https: 443,
      ws: 80,
      wss: 443,
      ftp: 21
    };
    var parseNoProxyEntry = (entry) => {
      let entryHost = entry;
      let entryPort = 0;
      if (entryHost.charAt(0) === "[") {
        const bracketIndex = entryHost.indexOf("]");
        if (bracketIndex !== -1) {
          const host = entryHost.slice(1, bracketIndex);
          const rest = entryHost.slice(bracketIndex + 1);
          if (rest.charAt(0) === ":" && /^\d+$/.test(rest.slice(1))) {
            entryPort = Number.parseInt(rest.slice(1), 10);
          }
          return [host, entryPort];
        }
      }
      const firstColon = entryHost.indexOf(":");
      const lastColon = entryHost.lastIndexOf(":");
      if (firstColon !== -1 && firstColon === lastColon && /^\d+$/.test(entryHost.slice(lastColon + 1))) {
        entryPort = Number.parseInt(entryHost.slice(lastColon + 1), 10);
        entryHost = entryHost.slice(0, lastColon);
      }
      return [entryHost, entryPort];
    };
    var IPV4_MAPPED_DOTTED_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:(\d+\.\d+\.\d+\.\d+)$/i;
    var IPV4_MAPPED_HEX_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
    var unmapIPv4MappedIPv6 = (host) => {
      if (typeof host !== "string" || host.indexOf(":") === -1) return host;
      const dotted = host.match(IPV4_MAPPED_DOTTED_RE);
      if (dotted) return dotted[1];
      const hex = host.match(IPV4_MAPPED_HEX_RE);
      if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      }
      return host;
    };
    var IPV4_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/;
    var ipv4ToBytes = (host) => {
      const parts = host.split(".");
      return parts.length === 4 && parts.every((part) => IPV4_OCTET_RE.test(part) && Number(part) <= 255) ? parts.map(Number) : null;
    };
    var IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/i;
    var ipv6ToBytes = (host) => {
      const halves = host.split("::");
      if (halves.length > 2) {
        return null;
      }
      const groups = halves[0] ? halves[0].split(":") : [];
      if (halves.length === 2) {
        const rear = halves[1] ? halves[1].split(":") : [];
        const missing = 8 - groups.length - rear.length;
        if (missing < 1) {
          return null;
        }
        groups.push(...new Array(missing).fill("0"), ...rear);
      }
      if (groups.length !== 8 || groups.some((group) => !IPV6_GROUP_RE.test(group))) {
        return null;
      }
      return groups.flatMap((group) => {
        const value = Number.parseInt(group, 16);
        return [value >> 8 & 255, value & 255];
      });
    };
    var ipToBytes = (host) => {
      if (typeof host !== "string" || !host) {
        return null;
      }
      return host.indexOf(":") !== -1 ? ipv6ToBytes(host) : ipv4ToBytes(host);
    };
    var normalizeNoProxyHost = (hostname) => {
      if (!hostname) {
        return hostname;
      }
      if (hostname.charAt(0) === "[" && hostname.charAt(hostname.length - 1) === "]") {
        hostname = hostname.slice(1, -1);
      }
      const trimmed = trimTrailingDots(hostname);
      const ipv4 = normalizeIPAddress(trimmed);
      if (ipv4 !== trimmed) {
        return ipv4;
      }
      return unmapIPv4MappedIPv6(trimmed);
    };
    var normalizeCidrBase = (input) => {
      let base = input;
      const startsBracket = base.charAt(0) === "[";
      const endsBracket = base.charAt(base.length - 1) === "]";
      const hasBracket = base.includes("[") || base.includes("]");
      if (startsBracket || endsBracket) {
        if (!startsBracket || !endsBracket) {
          return null;
        }
        base = base.slice(1, -1);
        if (base.indexOf(":") === -1 || base.includes("[") || base.includes("]")) {
          return null;
        }
      } else if (hasBracket) {
        return null;
      }
      if (!base || base.charAt(base.length - 1) === ".") {
        return null;
      }
      const wasIPv6 = base.indexOf(":") !== -1;
      if (wasIPv6) {
        try {
          base = new URL(`http://[${base}]/`).hostname.slice(1, -1);
        } catch (_err) {
          return null;
        }
      } else {
        base = normalizeIPAddress(base);
        if (!ipv4ToBytes(base)) {
          return null;
        }
      }
      return {
        normalized: unmapIPv4MappedIPv6(base),
        wasIPv6
      };
    };
    var CIDR_ENTRY_RE = /^(.+)\/(0|[1-9]\d{0,2})$/;
    var parseCidrEntry = (entry) => {
      if (entry.indexOf("/") === -1) {
        return void 0;
      }
      const match = CIDR_ENTRY_RE.exec(entry);
      if (!match) {
        return null;
      }
      let prefix = Number(match[2]);
      const parsedBase = normalizeCidrBase(match[1]);
      if (!parsedBase) {
        return null;
      }
      const {
        normalized,
        wasIPv6
      } = parsedBase;
      if (wasIPv6 && normalized.indexOf(":") === -1) {
        if (prefix < 96) {
          return null;
        }
        prefix -= 96;
      }
      const bytes = ipToBytes(normalized);
      if (!bytes || prefix > bytes.length * 8) {
        return null;
      }
      return {
        bytes,
        prefix
      };
    };
    var isInSubnet = (addressBytes, networkBytes, prefix) => {
      const fullBytes = prefix >> 3;
      for (let i = 0; i < fullBytes; i++) {
        if (addressBytes[i] !== networkBytes[i]) {
          return false;
        }
      }
      const remainingBits = prefix & 7;
      if (remainingBits) {
        const mask = 255 << 8 - remainingBits & 255;
        if ((addressBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask)) {
          return false;
        }
      }
      return true;
    };
    function shouldBypassProxy(location) {
      let parsed;
      try {
        parsed = new URL(location);
      } catch (_err) {
        return false;
      }
      const noProxy = (process.env.no_proxy || process.env.NO_PROXY || "").toLowerCase();
      if (!noProxy) {
        return false;
      }
      if (noProxy === "*") {
        return true;
      }
      const port = Number.parseInt(parsed.port, 10) || DEFAULT_PORTS[parsed.protocol.split(":", 1)[0]] || 0;
      const hostname = normalizeNoProxyHost(parsed.hostname.toLowerCase());
      const hostnameBytes = ipToBytes(hostname);
      return noProxy.split(/[\s,]+/).some((entry) => {
        if (!entry) {
          return false;
        }
        if (entry === "*") {
          return true;
        }
        const cidr = parseCidrEntry(entry);
        if (cidr !== void 0) {
          return cidr !== null && !!hostnameBytes && hostnameBytes.length === cidr.bytes.length && isInSubnet(hostnameBytes, cidr.bytes, cidr.prefix);
        }
        let [entryHost, entryPort] = parseNoProxyEntry(entry);
        entryHost = normalizeNoProxyHost(entryHost);
        if (!entryHost) {
          return false;
        }
        if (entryPort && entryPort !== port) {
          return false;
        }
        if (entryHost.charAt(0) === "*") {
          entryHost = entryHost.slice(1);
        }
        if (entryHost.charAt(0) === ".") {
          return hostname.endsWith(entryHost);
        }
        return hostname === entryHost || isLoopback(hostname) && isLoopback(entryHost);
      });
    }
    function speedometer(samplesCount, min) {
      samplesCount = samplesCount || 10;
      const bytes = new Array(samplesCount);
      const timestamps = new Array(samplesCount);
      let head = 0;
      let tail = 0;
      let firstSampleTS;
      min = min !== void 0 ? min : 1e3;
      return function push(chunkLength) {
        const now = Date.now();
        const startedAt = timestamps[tail];
        if (!firstSampleTS) {
          firstSampleTS = now;
        }
        bytes[head] = chunkLength;
        timestamps[head] = now;
        let i = tail;
        let bytesCount = 0;
        while (i !== head) {
          bytesCount += bytes[i++];
          i = i % samplesCount;
        }
        head = (head + 1) % samplesCount;
        if (head === tail) {
          tail = (tail + 1) % samplesCount;
        }
        if (now - firstSampleTS < min) {
          return;
        }
        const passed = startedAt && now - startedAt;
        return passed ? Math.round(bytesCount * 1e3 / passed) : void 0;
      };
    }
    function throttle(fn, freq) {
      let timestamp = 0;
      let threshold = 1e3 / freq;
      let lastArgs;
      let timer;
      const invoke = (args, now = Date.now()) => {
        timestamp = now;
        lastArgs = null;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        fn(...args);
      };
      const throttled = (...args) => {
        const now = Date.now();
        const passed = now - timestamp;
        if (passed >= threshold) {
          invoke(args, now);
        } else {
          lastArgs = args;
          if (!timer) {
            timer = setTimeout(() => {
              timer = null;
              invoke(lastArgs);
            }, threshold - passed);
          }
        }
      };
      const flush = () => lastArgs && invoke(lastArgs);
      const flushWith = (...args) => invoke(args);
      return [throttled, flush, flushWith];
    }
    var progressEventReducer = (listener, isDownloadStream, freq = 3) => {
      let bytesNotified = 0;
      const _speedometer = speedometer(50, 250);
      return throttle((e) => {
        if (!e || !utils$1.isNumber(e.loaded)) {
          return;
        }
        const rawLoaded = e.loaded;
        const total = e.lengthComputable ? e.total : void 0;
        const loaded = Math.max(0, total != null ? Math.min(rawLoaded, total) : rawLoaded);
        const progressBytes = Math.max(0, loaded - bytesNotified);
        const rate = _speedometer(progressBytes);
        bytesNotified = Math.max(bytesNotified, loaded);
        const data = {
          loaded,
          total,
          progress: total ? loaded / total : void 0,
          bytes: progressBytes,
          rate: rate ? rate : void 0,
          estimated: rate && total ? (total - loaded) / rate : void 0,
          event: e,
          lengthComputable: total != null,
          [isDownloadStream ? "download" : "upload"]: true
        };
        listener(data);
      }, freq);
    };
    var progressEventDecorator = (total, throttled) => {
      const lengthComputable = total != null;
      return [(loaded) => throttled[0]({
        lengthComputable,
        total,
        loaded
      }), throttled[1]];
    };
    var asyncDecorator = (fn, scheduler = utils$1.asap) => (...args) => scheduler(() => fn(...args));
    var isHexDigit = (charCode) => charCode >= 48 && charCode <= 57 || charCode >= 65 && charCode <= 70 || charCode >= 97 && charCode <= 102;
    var isPercentEncodedByte = (str, i, len) => i + 2 < len && isHexDigit(str.charCodeAt(i + 1)) && isHexDigit(str.charCodeAt(i + 2));
    var hexValue = (charCode) => charCode <= 57 ? charCode - 48 : (charCode & 223) - 55;
    var isBase64Char = (charCode) => charCode >= 65 && charCode <= 90 || // A-Z
    charCode >= 97 && charCode <= 122 || // a-z
    charCode >= 48 && charCode <= 57 || // 0-9
    charCode === 43 || // +
    charCode === 47 || // /
    charCode === 45 || // - (base64url)
    charCode === 95;
    var isBase64Whitespace = (charCode) => charCode === 9 || charCode === 10 || charCode === 12 || charCode === 13 || charCode === 32;
    var base64Bytes = (significant) => {
      const groups = Math.floor(significant / 4);
      const remainder = significant % 4;
      return groups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
    };
    var estimateBase64BufferAllocation = (body) => {
      const len = body.length;
      let padding = 0;
      if (len > 0 && body.charCodeAt(len - 1) === 61) {
        padding++;
        if (len > 1 && body.charCodeAt(len - 2) === 61) {
          padding++;
        }
      }
      return Math.floor((len - padding) * 3 / 4);
    };
    var estimatePercentDecodedBase64Bytes = (body) => {
      const len = body.length;
      let significant = 0;
      let padding = 0;
      let invalid = false;
      for (let i = 0; i < len; i++) {
        let code = body.charCodeAt(i);
        if (code === 37 && isPercentEncodedByte(body, i, len)) {
          code = hexValue(body.charCodeAt(i + 1)) * 16 + hexValue(body.charCodeAt(i + 2));
          i += 2;
        }
        if (isBase64Whitespace(code)) {
          continue;
        }
        if (code === 61) {
          padding++;
          continue;
        }
        if (!isBase64Char(code) || padding > 0) {
          invalid = true;
          continue;
        }
        significant++;
      }
      if (invalid || padding > 2 || padding > 0 && (significant + padding) % 4 !== 0 || significant % 4 === 1) {
        return estimateBase64BufferAllocation(body);
      }
      return base64Bytes(significant);
    };
    var estimateDataURLBytes = (url2, estimateBase64) => {
      if (!url2 || typeof url2 !== "string") return 0;
      if (!url2.startsWith("data:")) return 0;
      const comma = url2.indexOf(",");
      if (comma < 0) return 0;
      const meta = url2.slice(5, comma);
      const body = url2.slice(comma + 1);
      const isBase64 = /;base64/i.test(meta);
      if (isBase64) {
        return estimateBase64(body);
      }
      let bytes = 0;
      for (let i = 0, len = body.length; i < len; i++) {
        const c = body.charCodeAt(i);
        if (c === 37 && isPercentEncodedByte(body, i, len)) {
          bytes += 1;
          i += 2;
        } else if (c < 128) {
          bytes += 1;
        } else if (c < 2048) {
          bytes += 2;
        } else if (c >= 55296 && c <= 56319 && i + 1 < len) {
          const next = body.charCodeAt(i + 1);
          if (next >= 56320 && next <= 57343) {
            bytes += 4;
            i++;
          } else {
            bytes += 3;
          }
        } else {
          bytes += 3;
        }
      }
      return bytes;
    };
    function estimateDataURLDecodedBytes(url2) {
      const fragmentIndex = typeof url2 === "string" ? url2.indexOf("#") : -1;
      return estimateDataURLBytes(fragmentIndex === -1 ? url2 : url2.slice(0, fragmentIndex), estimatePercentDecodedBase64Bytes);
    }
    function estimateDataURLBufferAllocation(url2) {
      return estimateDataURLBytes(url2, estimateBase64BufferAllocation);
    }
    var zlibOptions = {
      flush: zlib.constants.Z_SYNC_FLUSH,
      finishFlush: zlib.constants.Z_SYNC_FLUSH
    };
    var brotliOptions = {
      flush: zlib.constants.BROTLI_OPERATION_FLUSH,
      finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
    };
    var zstdOptions = {
      flush: zlib.constants.ZSTD_e_flush,
      finishFlush: zlib.constants.ZSTD_e_flush
    };
    var isBrotliSupported = utils$1.isFunction(zlib.createBrotliDecompress);
    var isZstdSupported = utils$1.isFunction(zlib.createZstdDecompress);
    var ACCEPT_ENCODING = "gzip, compress, deflate" + (isBrotliSupported ? ", br" : "");
    var ACCEPT_ENCODING_WITH_ZSTD = ACCEPT_ENCODING + (isZstdSupported ? ", zstd" : "");
    var scheduleProgress = typeof process !== "undefined" && process.nextTick ? process.nextTick.bind(process) : utils$1.asap;
    var {
      http: httpFollow,
      https: httpsFollow
    } = followRedirects;
    var isHttps = /https:?/;
    var kAxiosSocketListener = /* @__PURE__ */ Symbol("axios.http.socketListener");
    var kAxiosCurrentReq = /* @__PURE__ */ Symbol("axios.http.currentReq");
    function handleSocketError(err) {
      const current = this[kAxiosCurrentReq];
      if (current && !current.destroyed) {
        current.destroy(err);
      }
    }
    var kAxiosInstalledTunnel = /* @__PURE__ */ Symbol("axios.http.installedTunnel");
    var tunnelingAgentCache = /* @__PURE__ */ new Map();
    var tunnelingAgentCacheUser = /* @__PURE__ */ new WeakMap();
    var NODE_NATIVE_ENV_PROXY_SUPPORT = {
      22: 21,
      24: 5
    };
    function isNodeNativeEnvProxySupported(nodeVersion = process.versions && process.versions.node) {
      if (!nodeVersion) {
        return false;
      }
      const [major, minor] = nodeVersion.split(".").map((part) => Number(part));
      if (!Number.isInteger(major) || !Number.isInteger(minor)) {
        return false;
      }
      if (major > 24) {
        return true;
      }
      return NODE_NATIVE_ENV_PROXY_SUPPORT[major] != null && minor >= NODE_NATIVE_ENV_PROXY_SUPPORT[major];
    }
    function isNodeEnvProxyEnabled(agent, nodeVersion = process.versions && process.versions.node) {
      if (!isNodeNativeEnvProxySupported(nodeVersion)) {
        return false;
      }
      const agentOptions = agent && agent.options;
      return Boolean(agentOptions && utils$1.hasOwnProp(agentOptions, "proxyEnv") && agentOptions.proxyEnv != null);
    }
    function getProxyEnvAgent(options, configHttpAgent, configHttpsAgent) {
      return isHttps.test(options.protocol) ? configHttpsAgent || https.globalAgent : configHttpAgent || http.globalAgent;
    }
    function getTunnelingAgent(agentOptions, userHttpsAgent) {
      const key = agentOptions.protocol + "//" + agentOptions.hostname + ":" + (agentOptions.port || "") + "#" + (agentOptions.auth || "");
      const cache = userHttpsAgent ? tunnelingAgentCacheUser.get(userHttpsAgent) || tunnelingAgentCacheUser.set(userHttpsAgent, /* @__PURE__ */ new Map()).get(userHttpsAgent) : tunnelingAgentCache;
      let agent = cache.get(key);
      if (agent) return agent;
      const merged = userHttpsAgent && userHttpsAgent.options ? {
        ...userHttpsAgent.options,
        ...agentOptions
      } : agentOptions;
      agent = new HttpsProxyAgent(merged);
      if (userHttpsAgent && userHttpsAgent.options) {
        const originTLSOptions = {
          ...userHttpsAgent.options
        };
        const callback = agent.callback;
        agent.callback = function axiosTunnelingAgentCallback(req, opts) {
          return callback.call(this, req, {
            ...originTLSOptions,
            ...opts
          });
        };
      }
      agent[kAxiosInstalledTunnel] = true;
      cache.set(key, agent);
      return agent;
    }
    var supportedProtocols = platform.protocols.map((protocol) => {
      return protocol + ":";
    });
    var decodeURIComponentSafe$1 = (value) => {
      if (!utils$1.isString(value)) {
        return value;
      }
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return value;
      }
    };
    var flushOnFinish = (stream2, [throttled, flush]) => {
      stream2.on("end", flush).on("error", flush);
      return throttled;
    };
    var http2Sessions = new Http2Sessions();
    function dispatchBeforeRedirect(options, responseDetails, requestDetails) {
      if (options.beforeRedirects.proxy) {
        options.beforeRedirects.proxy(options);
      }
      if (options.beforeRedirects.auth) {
        options.beforeRedirects.auth(options);
      }
      if (options.beforeRedirects.sensitiveHeaders) {
        options.beforeRedirects.sensitiveHeaders(options, requestDetails);
      }
      if (options.beforeRedirects.config) {
        options.beforeRedirects.config(options, responseDetails, requestDetails);
      }
    }
    function stripMatchingHeaders(headers, sensitiveSet) {
      if (!headers) {
        return;
      }
      Object.keys(headers).forEach((header) => {
        if (sensitiveSet.has(header.toLowerCase())) {
          delete headers[header];
        }
      });
    }
    function isSameOriginRedirect(redirectOptions, requestDetails) {
      if (!requestDetails) {
        return false;
      }
      try {
        return new URL(requestDetails.url).origin === new URL(redirectOptions.href).origin;
      } catch (e) {
        return false;
      }
    }
    function setProxy(options, configProxy, location, isRedirect, configHttpsAgent, configHttpAgent, allowEnvProxy = true) {
      let proxy = configProxy;
      const proxyEnvAgent = getProxyEnvAgent(options, configHttpAgent, configHttpsAgent);
      if (!proxy && proxy !== false && allowEnvProxy && !isNodeEnvProxyEnabled(proxyEnvAgent)) {
        const proxyUrl = getProxyForUrl(location);
        if (proxyUrl) {
          if (!shouldBypassProxy(location)) {
            proxy = new URL(proxyUrl);
          }
        }
      }
      if (isRedirect && options.headers) {
        for (const name of Object.keys(options.headers)) {
          if (name.toLowerCase() === "proxy-authorization") {
            delete options.headers[name];
          }
        }
      }
      if (isRedirect && options.agent && options.agent[kAxiosInstalledTunnel]) {
        options.agent = void 0;
      }
      if (proxy) {
        const isProxyURL = proxy instanceof URL;
        const readProxyField = (key) => isProxyURL || utils$1.hasOwnProp(proxy, key) ? proxy[key] : void 0;
        const proxyUsername = readProxyField("username");
        const proxyPassword = readProxyField("password");
        let proxyAuth = utils$1.hasOwnProp(proxy, "auth") ? proxy.auth : void 0;
        if (proxyUsername) {
          proxyAuth = (proxyUsername || "") + ":" + (proxyPassword || "");
        }
        if (proxyAuth) {
          const authIsObject = typeof proxyAuth === "object";
          const authUsername = authIsObject && utils$1.hasOwnProp(proxyAuth, "username") ? proxyAuth.username : void 0;
          const authPassword = authIsObject && utils$1.hasOwnProp(proxyAuth, "password") ? proxyAuth.password : void 0;
          const validProxyAuth = Boolean(authUsername || authPassword);
          if (validProxyAuth) {
            proxyAuth = (authUsername || "") + ":" + (authPassword || "");
          } else if (authIsObject) {
            throw new AxiosError("Invalid proxy authorization", AxiosError.ERR_BAD_OPTION, {
              proxy
            });
          }
        }
        const targetIsHttps = isHttps.test(options.protocol);
        if (targetIsHttps) {
          if (!(configHttpsAgent instanceof HttpsProxyAgent)) {
            const proxyHost = readProxyField("hostname") || readProxyField("host");
            const proxyPort = readProxyField("port");
            const rawProxyProtocol = readProxyField("protocol");
            const normalizedProtocol = rawProxyProtocol ? rawProxyProtocol.includes(":") ? rawProxyProtocol : `${rawProxyProtocol}:` : "http:";
            const proxyHostForURL = proxyHost && proxyHost.includes(":") && !proxyHost.startsWith("[") ? `[${proxyHost}]` : proxyHost;
            const proxyURL = new URL(`${normalizedProtocol}//${proxyHostForURL}${proxyPort ? ":" + proxyPort : ""}`);
            const agentOptions = {
              protocol: proxyURL.protocol,
              hostname: proxyURL.hostname.replace(/^\[|\]$/g, ""),
              port: proxyURL.port,
              auth: proxyAuth && typeof proxyAuth === "string" ? proxyAuth : void 0
            };
            if (proxyURL.protocol === "https:") {
              agentOptions.ALPNProtocols = ["http/1.1"];
            }
            const tunnelingAgent = getTunnelingAgent(agentOptions, configHttpsAgent);
            options.agent = tunnelingAgent;
            if (options.agents) {
              options.agents.https = tunnelingAgent;
            }
          }
        } else {
          if (proxyAuth) {
            const base64 = Buffer.from(proxyAuth, "utf8").toString("base64");
            options.headers["Proxy-Authorization"] = "Basic " + base64;
          }
          let hasUserHostHeader = false;
          for (const name of Object.keys(options.headers)) {
            if (name.toLowerCase() === "host") {
              hasUserHostHeader = true;
              break;
            }
          }
          if (!hasUserHostHeader) {
            options.headers.host = options.hostname + (options.port ? ":" + options.port : "");
          }
          const proxyHost = readProxyField("hostname") || readProxyField("host");
          options.hostname = proxyHost;
          options.host = proxyHost;
          options.port = readProxyField("port");
          options.path = location;
          const proxyProtocol = readProxyField("protocol");
          if (proxyProtocol) {
            options.protocol = proxyProtocol.includes(":") ? proxyProtocol : `${proxyProtocol}:`;
          }
        }
      }
      options.beforeRedirects.proxy = function beforeRedirect(redirectOptions) {
        setProxy(redirectOptions, configProxy, redirectOptions.href, true, configHttpsAgent, configHttpAgent, allowEnvProxy);
      };
      return Boolean(proxy || configProxy !== false && allowEnvProxy && isNodeEnvProxyEnabled(proxyEnvAgent));
    }
    var isHttpAdapterSupported = typeof process !== "undefined" && utils$1.kindOf(process) === "process";
    var wrapAsync = (asyncExecutor) => {
      return new Promise((resolve, reject) => {
        let onDone;
        let isDone;
        const done = (value, isRejected) => {
          if (isDone) return;
          isDone = true;
          onDone && onDone(value, isRejected);
        };
        const _resolve = (value) => {
          done(value);
          resolve(value);
        };
        const _reject = (reason) => {
          done(reason, true);
          reject(reason);
        };
        asyncExecutor(_resolve, _reject, (onDoneHandler) => onDone = onDoneHandler).catch(_reject);
      });
    };
    var resolveFamily = ({
      address,
      family
    }) => {
      if (!utils$1.isString(address)) {
        throw new AxiosError("address must be a string", AxiosError.ERR_BAD_OPTION_VALUE);
      }
      return {
        address,
        family: family || (address.indexOf(".") < 0 ? 6 : 4)
      };
    };
    var buildAddressEntry = (address, family) => resolveFamily(utils$1.isObject(address) ? address : {
      address,
      family
    });
    var normalizedLookupCache = /* @__PURE__ */ new WeakMap();
    var normalizeLookup = (lookup) => {
      let normalized = normalizedLookupCache.get(lookup);
      if (normalized) {
        return normalized;
      }
      const callbackLookup = callbackify(lookup, (value) => utils$1.isArray(value) ? value : [value]);
      normalized = (hostname, opt, cb) => {
        callbackLookup(hostname, opt, (err, arg0, arg1) => {
          if (err) {
            return cb(err);
          }
          let addresses;
          try {
            addresses = utils$1.isArray(arg0) ? arg0.map((addr) => buildAddressEntry(addr)) : [buildAddressEntry(arg0, arg1)];
          } catch (error) {
            return cb(error);
          }
          opt.all ? cb(err, addresses) : cb(err, addresses[0].address, addresses[0].family);
        });
      };
      normalizedLookupCache.set(lookup, normalized);
      return normalized;
    };
    var http2Transport = {
      request(options, cb) {
        const authority = options.protocol + "//" + options.hostname + ":" + (options.port || (options.protocol === "https:" ? 443 : 80));
        const {
          http2Options,
          headers
        } = options;
        const session = http2Sessions.getSession(authority, http2Options);
        const {
          HTTP2_HEADER_SCHEME,
          HTTP2_HEADER_METHOD,
          HTTP2_HEADER_PATH,
          HTTP2_HEADER_STATUS
        } = http2.constants;
        const http2Headers = {
          [HTTP2_HEADER_SCHEME]: options.protocol.replace(":", ""),
          [HTTP2_HEADER_METHOD]: options.method,
          [HTTP2_HEADER_PATH]: options.path
        };
        utils$1.forEach(headers, (header, name) => {
          name.charAt(0) !== ":" && (http2Headers[name] = header);
        });
        const req = session.request(http2Headers);
        req.once("response", (responseHeaders) => {
          const response = req;
          responseHeaders = Object.assign({}, responseHeaders);
          const status = responseHeaders[HTTP2_HEADER_STATUS];
          delete responseHeaders[HTTP2_HEADER_STATUS];
          response.headers = responseHeaders;
          response.statusCode = +status;
          cb(response);
        });
        return req;
      }
    };
    var httpAdapter = isHttpAdapterSupported && function httpAdapter2(config) {
      return wrapAsync(async function dispatchHttpRequest(resolve, reject, onDone) {
        const own2 = (key) => utils$1.getSafeProp(config, key);
        const transitional = own2("transitional") || transitionalDefaults;
        let data = own2("data");
        let lookup = own2("lookup");
        let family = own2("family");
        let httpVersion = own2("httpVersion");
        if (httpVersion === void 0) httpVersion = 1;
        const rawHttpVersion = httpVersion;
        let http2Options = own2("http2Options");
        const httpAgent = own2("httpAgent");
        const httpsAgent = own2("httpsAgent");
        const configProxy = own2("proxy");
        const responseType = own2("responseType");
        const responseEncoding = own2("responseEncoding");
        const socketPath = own2("socketPath");
        const method = own2("method").toUpperCase();
        const maxRedirects = own2("maxRedirects");
        const maxBodyLength = own2("maxBodyLength");
        const maxContentLength = own2("maxContentLength");
        const decompress = own2("decompress");
        let isDone;
        let rejected = false;
        let req;
        let connectPhaseTimer;
        try {
          httpVersion = +httpVersion;
        } catch (err) {
          throw new AxiosError("Invalid protocol version: value is not a number", AxiosError.ERR_BAD_OPTION_VALUE, config);
        }
        if (Number.isNaN(httpVersion)) {
          throw new AxiosError(`Invalid protocol version: '${rawHttpVersion}' is not a number`, AxiosError.ERR_BAD_OPTION_VALUE, config);
        }
        if (httpVersion !== 1 && httpVersion !== 2) {
          throw new AxiosError(`Unsupported protocol version '${httpVersion}'`, AxiosError.ERR_BAD_OPTION_VALUE, config);
        }
        const isHttp2 = httpVersion === 2;
        if (lookup) {
          lookup = normalizeLookup(lookup);
        }
        const abortEmitter = new events.EventEmitter();
        function abort(reason) {
          try {
            abortEmitter.emit("abort", !reason || reason.type ? new CanceledError(null, config, req) : reason);
          } catch (err) {
          }
        }
        function clearConnectPhaseTimer() {
          if (connectPhaseTimer) {
            clearTimeout(connectPhaseTimer);
            connectPhaseTimer = null;
          }
        }
        function createTimeoutError() {
          const configTimeout = own2("timeout");
          let timeoutErrorMessage = configTimeout ? "timeout of " + configTimeout + "ms exceeded" : "timeout exceeded";
          const configTimeoutErrorMessage = own2("timeoutErrorMessage");
          if (configTimeoutErrorMessage) {
            timeoutErrorMessage = configTimeoutErrorMessage;
          }
          return new AxiosError(timeoutErrorMessage, transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED, config, req);
        }
        abortEmitter.once("abort", reject);
        const onFinished = () => {
          clearConnectPhaseTimer();
          if (config.cancelToken) {
            config.cancelToken.unsubscribe(abort);
          }
          if (config.signal) {
            config.signal.removeEventListener("abort", abort);
          }
          abortEmitter.removeAllListeners();
        };
        if (config.cancelToken || config.signal) {
          config.cancelToken && config.cancelToken.subscribe(abort);
          if (config.signal) {
            config.signal.aborted ? abort() : config.signal.addEventListener("abort", abort);
          }
        }
        onDone((response, isRejected) => {
          isDone = true;
          clearConnectPhaseTimer();
          if (isRejected) {
            rejected = true;
            onFinished();
            return;
          }
          const {
            data: data2
          } = response;
          if (data2 instanceof stream.Readable || data2 instanceof stream.Duplex) {
            const offListeners = stream.finished(data2, () => {
              offListeners();
              onFinished();
            });
          } else {
            onFinished();
          }
        });
        const fullPath = buildFullPath(own2("baseURL"), own2("url"), own2("allowAbsoluteUrls"), config);
        const urlBase = socketPath ? "http://localhost" : platform.hasBrowserEnv ? platform.origin : void 0;
        const parsed = new URL(fullPath, urlBase);
        const protocol = parsed.protocol || supportedProtocols[0];
        if (protocol === "data:") {
          if (maxContentLength > -1) {
            const dataUrl = String(own2("url") || fullPath || "");
            const estimated = estimateDataURLBufferAllocation(dataUrl);
            if (estimated > maxContentLength) {
              return reject(new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config));
            }
          }
          let convertedData;
          if (method !== "GET") {
            return settle(resolve, reject, {
              status: 405,
              statusText: "method not allowed",
              headers: {},
              config
            });
          }
          try {
            convertedData = fromDataURI(own2("url"), responseType === "blob", {
              Blob: config.env && config.env.Blob
            });
          } catch (err) {
            throw AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config);
          }
          if (responseType === "text") {
            convertedData = convertedData.toString(responseEncoding);
            if (!responseEncoding || responseEncoding === "utf8") {
              convertedData = utils$1.stripBOM(convertedData);
            }
          } else if (responseType === "stream") {
            convertedData = stream.Readable.from(convertedData);
          }
          return settle(resolve, reject, {
            data: convertedData,
            status: 200,
            statusText: "OK",
            headers: new AxiosHeaders(),
            config
          });
        }
        if (supportedProtocols.indexOf(protocol) === -1) {
          return reject(new AxiosError("Unsupported protocol " + protocol, AxiosError.ERR_BAD_REQUEST, config));
        }
        const headers = AxiosHeaders.from(config.headers).normalize();
        headers.set("User-Agent", "axios/" + VERSION, false);
        const {
          onUploadProgress,
          onDownloadProgress
        } = config;
        const maxRate = config.maxRate;
        let maxUploadRate = void 0;
        let maxDownloadRate = void 0;
        if (utils$1.isSpecCompliantForm(data)) {
          const userBoundary = headers.getContentType(/boundary=([-_\w\d]{10,70})/i);
          data = formDataToStream(data, (formHeaders) => {
            headers.set(formHeaders);
          }, {
            tag: `axios-${VERSION}-boundary`,
            boundary: userBoundary && userBoundary[1] || void 0
          });
        } else if (utils$1.isFormData(data) && utils$1.isFunction(data.getHeaders) && data.getHeaders !== Object.prototype.getHeaders) {
          setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
          if (!headers.hasContentLength()) {
            try {
              const knownLength = await util.promisify(data.getLength).call(data);
              Number.isFinite(knownLength) && knownLength >= 0 && headers.setContentLength(knownLength);
            } catch (e) {
            }
          }
        } else if (utils$1.isBlob(data) || utils$1.isFile(data)) {
          data.size && headers.setContentType(data.type || "application/octet-stream");
          headers.setContentLength(data.size || 0);
          data = stream.Readable.from(readBlob(data));
        } else if (data && !utils$1.isStream(data)) {
          if (Buffer.isBuffer(data)) ;
          else if (utils$1.isArrayBuffer(data)) {
            data = Buffer.from(new Uint8Array(data));
          } else if (utils$1.isString(data)) {
            data = Buffer.from(data, "utf-8");
          } else {
            return reject(new AxiosError("Data after transformation must be a string, an ArrayBuffer, a Buffer, or a Stream", AxiosError.ERR_BAD_REQUEST, config));
          }
          headers.setContentLength(data.length, false);
          if (maxBodyLength > -1 && data.length > maxBodyLength) {
            return reject(new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config));
          }
        }
        const contentLength = utils$1.toFiniteNumber(headers.getContentLength());
        if (utils$1.isArray(maxRate)) {
          maxUploadRate = maxRate[0];
          maxDownloadRate = maxRate[1];
        } else {
          maxUploadRate = maxDownloadRate = maxRate;
        }
        if (data && (onUploadProgress || maxUploadRate)) {
          if (!utils$1.isStream(data)) {
            data = stream.Readable.from(data, {
              objectMode: false
            });
          }
          data = stream.pipeline([data, new AxiosTransformStream({
            maxRate: utils$1.toFiniteNumber(maxUploadRate)
          })], utils$1.noop);
          onUploadProgress && data.on("progress", flushOnFinish(data, progressEventDecorator(contentLength, progressEventReducer(asyncDecorator(onUploadProgress, scheduleProgress), false, 3))));
        }
        let auth = void 0;
        const configAuth = own2("auth");
        if (configAuth) {
          const username = utils$1.getSafeProp(configAuth, "username") || "";
          const password = utils$1.getSafeProp(configAuth, "password") || "";
          auth = username + ":" + password;
        }
        if (!auth && (parsed.username || parsed.password)) {
          const urlUsername = decodeURIComponentSafe$1(parsed.username);
          const urlPassword = decodeURIComponentSafe$1(parsed.password);
          auth = urlUsername + ":" + urlPassword;
        }
        auth && headers.delete("authorization");
        let path$1;
        try {
          path$1 = buildURL(parsed.pathname + parsed.search, own2("params"), own2("paramsSerializer")).replace(/^\?/, "");
        } catch (err) {
          return reject(AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config, null, null, {
            url: own2("url"),
            exists: true
          }));
        }
        headers.set("Accept-Encoding", utils$1.hasOwnProp(transitional, "advertiseZstdAcceptEncoding") && transitional.advertiseZstdAcceptEncoding === true ? ACCEPT_ENCODING_WITH_ZSTD : ACCEPT_ENCODING, false);
        if (isHttp2 && lookup) {
          http2Options = Object.assign(/* @__PURE__ */ Object.create(null), http2Options, {
            lookup
          });
        }
        const options = Object.assign(/* @__PURE__ */ Object.create(null), {
          path: path$1,
          method,
          headers: toByteStringHeaderObject(headers),
          agents: {
            http: httpAgent,
            https: httpsAgent
          },
          auth,
          protocol,
          family,
          beforeRedirect: dispatchBeforeRedirect,
          beforeRedirects: /* @__PURE__ */ Object.create(null),
          http2Options,
          createConnection: void 0
        });
        !utils$1.isUndefined(lookup) && (options.lookup = lookup);
        let proxyApplied = false;
        if (socketPath) {
          if (typeof socketPath !== "string") {
            return reject(new AxiosError("socketPath must be a string", AxiosError.ERR_BAD_OPTION_VALUE, config));
          }
          const allowedSocketPaths = own2("allowedSocketPaths");
          if (allowedSocketPaths != null) {
            const allowed = Array.isArray(allowedSocketPaths) ? allowedSocketPaths : [allowedSocketPaths];
            const resolvedSocket = path2.resolve(socketPath);
            const isAllowed = allowed.some((entry) => typeof entry === "string" && path2.resolve(entry) === resolvedSocket);
            if (!isAllowed) {
              return reject(new AxiosError(`socketPath "${socketPath}" is not permitted by allowedSocketPaths`, AxiosError.ERR_BAD_OPTION_VALUE, config));
            }
          }
          options.socketPath = socketPath;
        } else {
          options.hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
          options.port = parsed.port;
          proxyApplied = setProxy(
            options,
            configProxy,
            protocol + "//" + parsed.hostname + (parsed.port ? ":" + parsed.port : "") + options.path,
            false,
            httpsAgent,
            httpAgent,
            // The HTTP/2 transport connects independently of HTTP/1 agents, so it
            // cannot apply either axios-resolved or agent-local environment proxies.
            // Explicit proxy config is still processed and rejected below.
            !isHttp2
          );
        }
        let transport;
        let isNativeTransport = false;
        let transportEnforcesMaxBodyLength = false;
        const isHttpsRequest = isHttps.test(options.protocol);
        if (options.agent == null) {
          options.agent = isHttpsRequest ? httpsAgent : httpAgent;
        }
        if (isHttp2) {
          if (proxyApplied) {
            return reject(new AxiosError("HTTP/2 requests with a proxy are not supported", AxiosError.ERR_NOT_SUPPORT, config));
          }
          transport = http2Transport;
        } else {
          const configTransport = own2("transport");
          if (configTransport) {
            transport = configTransport;
          } else if (maxRedirects === 0) {
            transport = isHttpsRequest ? https : http;
            isNativeTransport = true;
          } else {
            transportEnforcesMaxBodyLength = true;
            options.sensitiveHeaders = [];
            if (maxRedirects) {
              options.maxRedirects = maxRedirects;
            }
            const configBeforeRedirect = own2("beforeRedirect");
            if (configBeforeRedirect) {
              options.beforeRedirects.config = configBeforeRedirect;
            }
            if (auth) {
              const requestOrigin = parsed.origin;
              const authToRestore = auth;
              options.beforeRedirects.auth = function beforeRedirectAuth(redirectOptions) {
                try {
                  if (new URL(redirectOptions.href).origin === requestOrigin) {
                    redirectOptions.auth = authToRestore;
                  }
                } catch (e) {
                }
              };
            }
            const sensitiveHeaders = own2("sensitiveHeaders");
            if (sensitiveHeaders != null) {
              if (!utils$1.isArray(sensitiveHeaders)) {
                return reject(new AxiosError("sensitiveHeaders must be an array of strings", AxiosError.ERR_BAD_OPTION_VALUE, config));
              }
              const sensitiveSet = /* @__PURE__ */ new Set();
              for (const header of sensitiveHeaders) {
                if (!utils$1.isString(header)) {
                  return reject(new AxiosError("sensitiveHeaders must be an array of strings", AxiosError.ERR_BAD_OPTION_VALUE, config));
                }
                sensitiveSet.add(header.toLowerCase());
              }
              if (sensitiveSet.size) {
                options.sensitiveHeaders = Array.from(sensitiveSet);
                options.beforeRedirects.sensitiveHeaders = function beforeRedirectSensitiveHeaders(redirectOptions, requestDetails) {
                  if (!isSameOriginRedirect(redirectOptions, requestDetails)) {
                    stripMatchingHeaders(redirectOptions.headers, sensitiveSet);
                  }
                };
              }
            }
            transport = isHttpsRequest ? httpsFollow : httpFollow;
          }
        }
        if (maxBodyLength > -1) {
          options.maxBodyLength = maxBodyLength;
        } else {
          options.maxBodyLength = Infinity;
        }
        options.insecureHTTPParser = Boolean(own2("insecureHTTPParser"));
        req = transport.request(options, function handleResponse(res) {
          clearConnectPhaseTimer();
          if (req.destroyed) return;
          const streams = [res];
          const responseLength = utils$1.toFiniteNumber(res.headers["content-length"]);
          if (onDownloadProgress || maxDownloadRate) {
            const transformStream = new AxiosTransformStream({
              maxRate: utils$1.toFiniteNumber(maxDownloadRate)
            });
            onDownloadProgress && transformStream.on("progress", flushOnFinish(transformStream, progressEventDecorator(responseLength, progressEventReducer(asyncDecorator(onDownloadProgress, scheduleProgress), true, 3))));
            streams.push(transformStream);
          }
          let responseStream = res;
          const lastRequest = res.req || req;
          if (decompress !== false && res.headers["content-encoding"]) {
            if (method === "HEAD" || res.statusCode === 204) {
              delete res.headers["content-encoding"];
            }
            switch ((res.headers["content-encoding"] || "").toLowerCase()) {
              /*eslint default-case:0*/
              case "gzip":
              case "x-gzip":
              case "compress":
              case "x-compress":
                streams.push(zlib.createUnzip(zlibOptions));
                delete res.headers["content-encoding"];
                break;
              case "deflate":
                streams.push(new ZlibHeaderTransformStream());
                streams.push(zlib.createUnzip(zlibOptions));
                delete res.headers["content-encoding"];
                break;
              case "br":
                if (isBrotliSupported) {
                  streams.push(zlib.createBrotliDecompress(brotliOptions));
                  delete res.headers["content-encoding"];
                }
                break;
              case "zstd":
                if (isZstdSupported) {
                  streams.push(zlib.createZstdDecompress(zstdOptions));
                  delete res.headers["content-encoding"];
                }
                break;
            }
          }
          responseStream = streams.length > 1 ? stream.pipeline(streams, utils$1.noop) : streams[0];
          const response = {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: new AxiosHeaders(res.headers),
            config,
            request: lastRequest
          };
          if (responseType === "stream") {
            if (maxContentLength > -1) {
              const limit = maxContentLength;
              const source = responseStream;
              async function* enforceMaxContentLength() {
                let totalResponseBytes = 0;
                for await (const chunk of source) {
                  totalResponseBytes += chunk.length;
                  if (totalResponseBytes > limit) {
                    throw new AxiosError("maxContentLength size of " + limit + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, lastRequest);
                  }
                  yield chunk;
                }
              }
              responseStream = stream.Readable.from(enforceMaxContentLength(), {
                objectMode: false
              });
            }
            response.data = responseStream;
            settle(resolve, reject, response);
          } else {
            const responseBuffer = [];
            let totalResponseBytes = 0;
            responseStream.on("data", function handleStreamData(chunk) {
              responseBuffer.push(chunk);
              totalResponseBytes += chunk.length;
              if (maxContentLength > -1 && totalResponseBytes > maxContentLength) {
                rejected = true;
                responseStream.destroy();
                abort(new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, lastRequest));
              }
            });
            responseStream.on("aborted", function handlerStreamAborted() {
              if (rejected) {
                return;
              }
              const err = new AxiosError("stream has been aborted", AxiosError.ERR_BAD_RESPONSE, config, lastRequest, response);
              responseStream.destroy(err);
              reject(err);
            });
            responseStream.on("error", function handleStreamError(err) {
              if (rejected) return;
              reject(AxiosError.from(err, null, config, lastRequest, response));
            });
            responseStream.on("end", function handleStreamEnd() {
              try {
                let responseData = responseBuffer.length === 1 ? responseBuffer[0] : Buffer.concat(responseBuffer);
                if (responseType !== "arraybuffer") {
                  responseData = responseData.toString(responseEncoding);
                  if (!responseEncoding || responseEncoding === "utf8") {
                    responseData = utils$1.stripBOM(responseData);
                  }
                }
                response.data = responseData;
              } catch (err) {
                return reject(AxiosError.from(err, null, config, response.request, response));
              }
              settle(resolve, reject, response);
            });
          }
          abortEmitter.once("abort", (err) => {
            if (!responseStream.destroyed) {
              responseStream.emit("error", err);
              responseStream.destroy();
            }
          });
        });
        abortEmitter.once("abort", (err) => {
          if (req.close) {
            req.close();
          } else {
            req.destroy(err);
          }
        });
        req.on("error", function handleRequestError(err) {
          reject(AxiosError.from(err, null, config, req));
        });
        const boundSockets = /* @__PURE__ */ new Set();
        req.on("socket", function handleRequestSocket(socket) {
          if (typeof socket.setKeepAlive === "function") {
            socket.setKeepAlive(true, 1e3 * 60);
          }
          if (!socket[kAxiosSocketListener]) {
            socket.on("error", handleSocketError);
            socket[kAxiosSocketListener] = true;
          }
          socket[kAxiosCurrentReq] = req;
          boundSockets.add(socket);
        });
        req.once("close", function clearCurrentReq() {
          clearConnectPhaseTimer();
          for (const socket of boundSockets) {
            if (socket[kAxiosCurrentReq] === req) {
              socket[kAxiosCurrentReq] = null;
            }
          }
          boundSockets.clear();
        });
        if (own2("timeout")) {
          const timeout = parseInt(own2("timeout"), 10);
          if (Number.isNaN(timeout)) {
            abort(new AxiosError("error trying to parse `config.timeout` to int", AxiosError.ERR_BAD_OPTION_VALUE, config, req));
            return;
          }
          const handleTimeout = function handleTimeout2() {
            if (isDone) return;
            abort(createTimeoutError());
          };
          if (isNativeTransport && timeout > 0) {
            connectPhaseTimer = setTimeout(handleTimeout, timeout);
          }
          req.setTimeout(timeout, handleTimeout);
        } else {
          req.setTimeout(0);
        }
        if (utils$1.isStream(data)) {
          let ended = false;
          let errored = false;
          data.on("end", () => {
            ended = true;
          });
          data.once("error", (err) => {
            errored = true;
            req.destroy(err);
          });
          data.on("close", () => {
            if (!ended && !errored) {
              abort(new CanceledError("Request stream has been aborted", config, req));
            }
          });
          let uploadStream = data;
          if (maxBodyLength > -1 && !transportEnforcesMaxBodyLength) {
            const limit = maxBodyLength;
            let bytesSent = 0;
            uploadStream = stream.pipeline([data, new stream.Transform({
              transform(chunk, _enc, cb) {
                bytesSent += chunk.length;
                if (bytesSent > limit) {
                  return cb(new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config, req));
                }
                cb(null, chunk);
              }
            })], utils$1.noop);
            uploadStream.on("error", (err) => {
              if (!req.destroyed) req.destroy(err);
            });
          }
          uploadStream.pipe(req);
        } else {
          data && req.write(data);
          req.end();
        }
      });
    };
    var isURLSameOrigin = platform.hasStandardBrowserEnv ? /* @__PURE__ */ ((origin2, isMSIE) => (url2) => {
      url2 = new URL(url2, platform.origin);
      return origin2.protocol === url2.protocol && origin2.host === url2.host && (isMSIE || origin2.port === url2.port);
    })(new URL(platform.origin), platform.navigator && /(msie|trident)/i.test(platform.navigator.userAgent)) : () => true;
    var cookies = platform.hasStandardBrowserEnv ? (
      // Standard browser envs support document.cookie
      {
        write(name, value, expires, path3, domain, secure, sameSite) {
          if (typeof document === "undefined") return;
          const cookie = [`${name}=${encodeURIComponent(value)}`];
          if (utils$1.isNumber(expires)) {
            cookie.push(`expires=${new Date(expires).toUTCString()}`);
          }
          if (utils$1.isString(path3)) {
            cookie.push(`path=${path3}`);
          }
          if (utils$1.isString(domain)) {
            cookie.push(`domain=${domain}`);
          }
          if (secure === true) {
            cookie.push("secure");
          }
          if (utils$1.isString(sameSite)) {
            cookie.push(`SameSite=${sameSite}`);
          }
          document.cookie = cookie.join("; ");
        },
        read(name) {
          if (typeof document === "undefined") return null;
          const cookies2 = document.cookie.split(";");
          for (let i = 0; i < cookies2.length; i++) {
            const cookie = cookies2[i].replace(/^\s+/, "");
            const eq = cookie.indexOf("=");
            if (eq !== -1 && cookie.slice(0, eq) === name) {
              try {
                return decodeURIComponent(cookie.slice(eq + 1));
              } catch (e) {
                return cookie.slice(eq + 1);
              }
            }
          }
          return null;
        },
        remove(name) {
          this.write(name, "", Date.now() - 864e5, "/");
        }
      }
    ) : (
      // Non-standard browser env (web workers, react-native) lack needed support.
      {
        write() {
        },
        read() {
          return null;
        },
        remove() {
        }
      }
    );
    var headersToObject = (thing) => thing instanceof AxiosHeaders ? {
      ...thing
    } : thing;
    var ownEnumerableKeys = (thing) => {
      if (Object.getOwnPropertySymbols && Object.getOwnPropertyDescriptor) {
        return Object.keys(thing).concat(Object.getOwnPropertySymbols(thing).filter((symbol) => Object.getOwnPropertyDescriptor(thing, symbol).enumerable));
      }
      return Object.keys(thing);
    };
    function mergeConfig(config1, config2) {
      config1 = config1 || {};
      config2 = config2 || {};
      const config = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(config, "hasOwnProperty", {
        // Null-proto descriptor so a polluted Object.prototype.get cannot turn
        // this data descriptor into an accessor descriptor on the way in.
        __proto__: null,
        value: Object.prototype.hasOwnProperty,
        enumerable: false,
        writable: true,
        configurable: true
      });
      function getMergedValue(target, source, prop, caseless) {
        if (utils$1.isPlainObject(target) && utils$1.isPlainObject(source)) {
          return utils$1.merge.call({
            caseless
          }, target, source);
        } else if (utils$1.isPlainObject(source)) {
          return utils$1.merge({}, source);
        } else if (utils$1.isArray(source)) {
          return source.slice();
        }
        return source;
      }
      function mergeDeepProperties(a, b, prop, caseless) {
        if (!utils$1.isUndefined(b)) {
          return getMergedValue(a, b, prop, caseless);
        } else if (!utils$1.isUndefined(a)) {
          return getMergedValue(void 0, a, prop, caseless);
        }
      }
      function valueFromConfig2(a, b) {
        if (!utils$1.isUndefined(b)) {
          return getMergedValue(void 0, b);
        }
      }
      function defaultToConfig2(a, b) {
        if (!utils$1.isUndefined(b)) {
          return getMergedValue(void 0, b);
        } else if (!utils$1.isUndefined(a)) {
          return getMergedValue(void 0, a);
        }
      }
      function getMergedTransitionalOption(prop) {
        const transitional2 = utils$1.hasOwnProp(config2, "transitional") ? config2.transitional : void 0;
        if (!utils$1.isUndefined(transitional2)) {
          if (utils$1.isPlainObject(transitional2)) {
            if (utils$1.hasOwnProp(transitional2, prop)) {
              return transitional2[prop];
            }
          } else {
            return void 0;
          }
        }
        const transitional1 = utils$1.hasOwnProp(config1, "transitional") ? config1.transitional : void 0;
        if (utils$1.isPlainObject(transitional1) && utils$1.hasOwnProp(transitional1, prop)) {
          return transitional1[prop];
        }
        return void 0;
      }
      function mergeDirectKeys(a, b, prop) {
        if (utils$1.hasOwnProp(config2, prop)) {
          return getMergedValue(a, b);
        } else if (utils$1.hasOwnProp(config1, prop)) {
          return getMergedValue(void 0, a);
        }
      }
      const mergeMap = {
        url: valueFromConfig2,
        method: valueFromConfig2,
        data: valueFromConfig2,
        baseURL: defaultToConfig2,
        transformRequest: defaultToConfig2,
        transformResponse: defaultToConfig2,
        paramsSerializer: defaultToConfig2,
        timeout: defaultToConfig2,
        timeoutErrorMessage: defaultToConfig2,
        withCredentials: defaultToConfig2,
        withXSRFToken: defaultToConfig2,
        adapter: defaultToConfig2,
        responseType: defaultToConfig2,
        xsrfCookieName: defaultToConfig2,
        xsrfHeaderName: defaultToConfig2,
        onUploadProgress: defaultToConfig2,
        onDownloadProgress: defaultToConfig2,
        decompress: defaultToConfig2,
        maxContentLength: defaultToConfig2,
        maxBodyLength: defaultToConfig2,
        beforeRedirect: defaultToConfig2,
        transport: defaultToConfig2,
        httpAgent: defaultToConfig2,
        httpsAgent: defaultToConfig2,
        cancelToken: defaultToConfig2,
        socketPath: defaultToConfig2,
        allowedSocketPaths: defaultToConfig2,
        responseEncoding: defaultToConfig2,
        validateStatus: mergeDirectKeys,
        headers: (a, b, prop) => mergeDeepProperties(headersToObject(a), headersToObject(b), prop, true)
      };
      utils$1.forEach(ownEnumerableKeys({
        ...config1,
        ...config2
      }), function computeConfigValue(prop) {
        if (prop === "__proto__" || prop === "constructor" || prop === "prototype") return;
        const merge2 = utils$1.hasOwnProp(mergeMap, prop) ? mergeMap[prop] : mergeDeepProperties;
        const a = utils$1.hasOwnProp(config1, prop) ? config1[prop] : void 0;
        const b = utils$1.hasOwnProp(config2, prop) ? config2[prop] : void 0;
        const configValue = merge2(a, b, prop);
        utils$1.isUndefined(configValue) && merge2 !== mergeDirectKeys || (config[prop] = configValue);
      });
      if (utils$1.hasOwnProp(config2, "validateStatus") && utils$1.isUndefined(config2.validateStatus) && getMergedTransitionalOption("validateStatusUndefinedResolves") === false) {
        if (utils$1.hasOwnProp(config1, "validateStatus")) {
          config.validateStatus = getMergedValue(void 0, config1.validateStatus);
        } else {
          delete config.validateStatus;
        }
      }
      return config;
    }
    var encodeUTF8$1 = (str) => encodeURIComponent(str).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    function resolveConfig(config) {
      const newConfig = mergeConfig({}, config);
      const own2 = (key) => utils$1.hasOwnProp(newConfig, key) ? newConfig[key] : void 0;
      const data = own2("data");
      let withXSRFToken = own2("withXSRFToken");
      const xsrfHeaderName = own2("xsrfHeaderName");
      const xsrfCookieName = own2("xsrfCookieName");
      let headers = own2("headers");
      const auth = own2("auth");
      const baseURL = own2("baseURL");
      const allowAbsoluteUrls = own2("allowAbsoluteUrls");
      const url2 = own2("url");
      newConfig.headers = headers = AxiosHeaders.from(headers);
      newConfig.url = buildURL(buildFullPath(baseURL, url2, allowAbsoluteUrls, newConfig), own2("params"), own2("paramsSerializer"));
      if (auth) {
        const username = utils$1.getSafeProp(auth, "username") || "";
        const password = utils$1.getSafeProp(auth, "password") || "";
        try {
          headers.set("Authorization", "Basic " + btoa(username + ":" + (password ? encodeUTF8$1(password) : "")));
        } catch (e) {
          throw AxiosError.from(e, AxiosError.ERR_BAD_OPTION_VALUE, config);
        }
      }
      if (utils$1.isFormData(data)) {
        const getHeaders = utils$1.getSafeProp(data, "getHeaders");
        if (platform.hasStandardBrowserEnv || platform.hasStandardBrowserWebWorkerEnv || utils$1.isReactNative(data)) {
          headers.setContentType(void 0);
        } else if (utils$1.isFunction(getHeaders)) {
          setFormDataHeaders(headers, getHeaders.call(data), own2("formDataHeaderPolicy"));
        }
      }
      if (platform.hasStandardBrowserEnv) {
        if (utils$1.isFunction(withXSRFToken)) {
          withXSRFToken = withXSRFToken(newConfig);
        }
        const shouldSendXSRF = withXSRFToken === true || withXSRFToken == null && isURLSameOrigin(newConfig.url);
        if (shouldSendXSRF) {
          const xsrfValue = xsrfHeaderName && xsrfCookieName && cookies.read(xsrfCookieName);
          if (xsrfValue) {
            headers.set(xsrfHeaderName, xsrfValue);
          }
        }
      }
      return newConfig;
    }
    var isXHRAdapterSupported = typeof XMLHttpRequest !== "undefined";
    var xhrAdapter = isXHRAdapterSupported && function(config) {
      return new Promise(function dispatchXhrRequest(resolve, reject) {
        const _config = resolveConfig(config);
        let requestData = _config.data;
        const requestHeaders = AxiosHeaders.from(_config.headers).normalize();
        let {
          responseType,
          onUploadProgress,
          onDownloadProgress
        } = _config;
        let onCanceled;
        let uploadThrottled, downloadThrottled;
        let flushUpload, flushDownload, flushDownloadWithEvent;
        function done() {
          flushUpload && flushUpload();
          flushDownload && flushDownload();
          _config.cancelToken && _config.cancelToken.unsubscribe(onCanceled);
          _config.signal && _config.signal.removeEventListener("abort", onCanceled);
        }
        let request = new XMLHttpRequest();
        request.open(_config.method.toUpperCase(), _config.url, true);
        request.timeout = _config.timeout;
        function onloadend(event) {
          if (!request) {
            return;
          }
          if (request.status === 0 && (parseProtocol(normalizeURLForProtocolCheck(_config.url)) || parseProtocol(platform.origin)) !== "file" && !(request.responseURL && request.responseURL.startsWith("file:"))) {
            reject(new AxiosError("Request aborted", AxiosError.ECONNABORTED, config, request));
            done();
            request = null;
            return;
          }
          try {
            if (event) {
              flushDownloadWithEvent && flushDownloadWithEvent(event);
            } else {
              flushDownload && flushDownload();
            }
          } catch (err) {
            setTimeout(() => {
              throw err;
            });
          }
          if (!request) {
            return;
          }
          const responseHeaders = AxiosHeaders.from("getAllResponseHeaders" in request && request.getAllResponseHeaders());
          const responseData = !responseType || responseType === "text" || responseType === "json" ? request.responseText : request.response;
          const response = {
            data: responseData,
            status: request.status,
            statusText: request.statusText,
            headers: responseHeaders,
            config,
            request
          };
          settle(function _resolve(value) {
            resolve(value);
            done();
          }, function _reject(err) {
            reject(err);
            done();
          }, response);
          request = null;
        }
        if ("onloadend" in request) {
          request.onloadend = onloadend;
        } else {
          request.onreadystatechange = function handleLoad() {
            if (!request || request.readyState !== 4) {
              return;
            }
            if (request.status === 0 && !(request.responseURL && request.responseURL.startsWith("file:"))) {
              return;
            }
            setTimeout(onloadend);
          };
        }
        request.onabort = function handleAbort() {
          if (!request) {
            return;
          }
          reject(new AxiosError("Request aborted", AxiosError.ECONNABORTED, config, request));
          done();
          request = null;
        };
        request.onerror = function handleError(event) {
          const msg = event && event.message ? event.message : "Network Error";
          const err = new AxiosError(msg, AxiosError.ERR_NETWORK, config, request);
          err.event = event || null;
          reject(err);
          done();
          request = null;
        };
        request.ontimeout = function handleTimeout() {
          let timeoutErrorMessage = _config.timeout ? "timeout of " + _config.timeout + "ms exceeded" : "timeout exceeded";
          const transitional = _config.transitional || transitionalDefaults;
          if (_config.timeoutErrorMessage) {
            timeoutErrorMessage = _config.timeoutErrorMessage;
          }
          reject(new AxiosError(timeoutErrorMessage, transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED, config, request));
          done();
          request = null;
        };
        requestData === void 0 && requestHeaders.setContentType(null);
        if ("setRequestHeader" in request) {
          utils$1.forEach(toByteStringHeaderObject(requestHeaders), function setRequestHeader(val, key) {
            request.setRequestHeader(key, val);
          });
        }
        if (!utils$1.isUndefined(_config.withCredentials)) {
          request.withCredentials = !!_config.withCredentials;
        }
        if (responseType && responseType !== "json") {
          request.responseType = _config.responseType;
        }
        if (onDownloadProgress) {
          [downloadThrottled, flushDownload, flushDownloadWithEvent] = progressEventReducer(onDownloadProgress, true);
          request.addEventListener("progress", downloadThrottled);
        }
        if (onUploadProgress && request.upload) {
          [uploadThrottled, flushUpload] = progressEventReducer(onUploadProgress);
          request.upload.addEventListener("progress", uploadThrottled);
          request.upload.addEventListener("loadend", flushUpload);
        }
        if (_config.cancelToken || _config.signal) {
          onCanceled = (cancel) => {
            if (!request) {
              return;
            }
            reject(!cancel || cancel.type ? new CanceledError(null, config, request) : cancel);
            request.abort();
            done();
            request = null;
          };
          _config.cancelToken && _config.cancelToken.subscribe(onCanceled);
          if (_config.signal) {
            _config.signal.aborted ? onCanceled() : _config.signal.addEventListener("abort", onCanceled);
          }
        }
        const protocol = parseProtocol(_config.url);
        if (protocol && !platform.protocols.includes(protocol)) {
          reject(new AxiosError("Unsupported protocol " + protocol + ":", AxiosError.ERR_BAD_REQUEST, config));
          done();
          return;
        }
        request.send(requestData || null);
      });
    };
    var composeSignals = (signals, timeout) => {
      signals = signals ? signals.filter(Boolean) : [];
      if (!timeout && !signals.length) {
        return;
      }
      const controller = new AbortController();
      let aborted = false;
      const onabort = function(reason) {
        if (!aborted) {
          aborted = true;
          unsubscribe();
          const err = reason instanceof Error ? reason : this.reason;
          controller.abort(err instanceof AxiosError ? err : new CanceledError(err instanceof Error ? err.message : err));
        }
      };
      let timer = timeout && setTimeout(() => {
        timer = null;
        onabort(new AxiosError(`timeout of ${timeout}ms exceeded`, AxiosError.ETIMEDOUT));
      }, timeout);
      const unsubscribe = () => {
        if (!signals) {
          return;
        }
        timer && clearTimeout(timer);
        timer = null;
        signals.forEach((signal2) => {
          signal2.unsubscribe ? signal2.unsubscribe(onabort) : signal2.removeEventListener("abort", onabort);
        });
        signals = null;
      };
      signals.forEach((signal2) => {
        if (aborted) {
          return;
        }
        if (signal2.aborted) {
          onabort.call(signal2);
          return;
        }
        signal2.addEventListener("abort", onabort, {
          once: true
        });
      });
      const {
        signal
      } = controller;
      signal.unsubscribe = () => utils$1.asap(unsubscribe);
      return signal;
    };
    var streamChunk = function* (chunk, chunkSize) {
      let len = chunk.byteLength;
      if (len < chunkSize) {
        yield chunk;
        return;
      }
      let pos = 0;
      let end;
      while (pos < len) {
        end = pos + chunkSize;
        yield chunk.slice(pos, end);
        pos = end;
      }
    };
    var readBytes = async function* (iterable, chunkSize) {
      for await (const chunk of readStream(iterable)) {
        yield* streamChunk(chunk, chunkSize);
      }
    };
    var readStream = async function* (stream2) {
      if (stream2[Symbol.asyncIterator]) {
        yield* stream2;
        return;
      }
      const reader = stream2.getReader();
      try {
        for (; ; ) {
          const {
            done,
            value
          } = await reader.read();
          if (done) {
            break;
          }
          yield value;
        }
      } finally {
        await reader.cancel();
      }
    };
    var trackStream = (stream2, chunkSize, onProgress, onFinish) => {
      const iterator2 = readBytes(stream2, chunkSize);
      let bytes = 0;
      let done;
      let _onFinish = (e) => {
        if (!done) {
          done = true;
          onFinish && onFinish(e);
        }
      };
      return new ReadableStream({
        async pull(controller) {
          try {
            const {
              done: done2,
              value
            } = await iterator2.next();
            if (done2) {
              _onFinish();
              controller.close();
              return;
            }
            let len = value.byteLength;
            if (onProgress) {
              let loadedBytes = bytes += len;
              onProgress(loadedBytes);
            }
            controller.enqueue(new Uint8Array(value));
          } catch (err) {
            _onFinish(err);
            throw err;
          }
        },
        cancel(reason) {
          _onFinish(reason);
          return iterator2.return();
        }
      }, {
        highWaterMark: 2
      });
    };
    var DEFAULT_CHUNK_SIZE = 64 * 1024;
    var DEFAULT_REQUEST_OPTIONS = {
      cache: "default",
      redirect: "follow",
      referrer: "about:client",
      referrerPolicy: "",
      mode: "cors",
      integrity: "",
      keepalive: false,
      priority: "auto",
      window: null
    };
    var {
      isFunction
    } = utils$1;
    var encodeUTF8 = (str) => encodeURIComponent(str).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    var decodeURIComponentSafe = (value) => {
      if (!utils$1.isString(value)) {
        return value;
      }
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return value;
      }
    };
    var test = (fn, ...args) => {
      try {
        return !!fn(...args);
      } catch (e) {
        return false;
      }
    };
    var maybeWithAuthCredentials = (url2) => {
      const protocolIndex = url2.indexOf("://");
      let urlToCheck = url2;
      if (protocolIndex !== -1) {
        urlToCheck = urlToCheck.slice(protocolIndex + 3);
      }
      return urlToCheck.includes("@") || urlToCheck.includes(":");
    };
    var factory = (env) => {
      const globalObject = utils$1.global !== void 0 && utils$1.global !== null ? utils$1.global : globalThis;
      const {
        ReadableStream: ReadableStream2,
        TextEncoder: TextEncoder2
      } = globalObject;
      env = utils$1.merge.call({
        skipUndefined: true
      }, {
        Request: globalObject.Request,
        Response: globalObject.Response
      }, env);
      const {
        fetch: envFetch,
        Request,
        Response
      } = env;
      const isFetchSupported = envFetch ? isFunction(envFetch) : typeof fetch === "function";
      const isRequestSupported = isFunction(Request);
      const isResponseSupported = isFunction(Response);
      if (!isFetchSupported) {
        return false;
      }
      const isReadableStreamSupported = isFetchSupported && isFunction(ReadableStream2);
      const encodeText = isFetchSupported && (typeof TextEncoder2 === "function" ? /* @__PURE__ */ ((encoder) => (str) => encoder.encode(str))(new TextEncoder2()) : async (str) => new Uint8Array(await new Request(str).arrayBuffer()));
      const supportsRequestStream = isRequestSupported && isReadableStreamSupported && test(() => {
        let duplexAccessed = false;
        const request = new Request(platform.origin, {
          body: new ReadableStream2(),
          method: "POST",
          get duplex() {
            duplexAccessed = true;
            return "half";
          }
        });
        const hasContentType = request.headers.has("Content-Type");
        if (request.body != null) {
          request.body.cancel();
        }
        return duplexAccessed && !hasContentType;
      });
      const supportsResponseStream = isResponseSupported && isReadableStreamSupported && test(() => utils$1.isReadableStream(new Response("").body));
      const resolvers = {
        stream: supportsResponseStream && ((res) => res.body)
      };
      isFetchSupported && (() => {
        ["text", "arrayBuffer", "blob", "formData", "stream"].forEach((type) => {
          !resolvers[type] && (resolvers[type] = (res, config) => {
            let method = res && res[type];
            if (method) {
              return method.call(res);
            }
            throw new AxiosError(`Response type '${type}' is not supported`, AxiosError.ERR_NOT_SUPPORT, config);
          });
        });
      })();
      const getBodyLength = async (body) => {
        if (body == null) {
          return 0;
        }
        if (utils$1.isBlob(body)) {
          return body.size;
        }
        if (utils$1.isSpecCompliantForm(body)) {
          const _request = new Request(platform.origin, {
            method: "POST",
            body
          });
          return (await _request.arrayBuffer()).byteLength;
        }
        if (utils$1.isArrayBufferView(body) || utils$1.isArrayBuffer(body)) {
          return body.byteLength;
        }
        if (utils$1.isURLSearchParams(body)) {
          body = body + "";
        }
        if (utils$1.isString(body)) {
          return (await encodeText(body)).byteLength;
        }
      };
      const resolveBodyLength = async (headers, body) => {
        const length = utils$1.toFiniteNumber(headers.getContentLength());
        return length == null ? getBodyLength(body) : length;
      };
      return async (config) => {
        let {
          url: url2,
          method,
          data,
          signal,
          cancelToken,
          timeout,
          onDownloadProgress,
          onUploadProgress,
          responseType,
          headers,
          withCredentials = "same-origin",
          fetchOptions,
          maxContentLength,
          maxBodyLength,
          maxRedirects
        } = resolveConfig(config);
        const hasMaxContentLength = utils$1.isNumber(maxContentLength) && maxContentLength > -1;
        const hasMaxBodyLength = utils$1.isNumber(maxBodyLength) && maxBodyLength > -1;
        const own2 = (key) => utils$1.hasOwnProp(config, key) ? config[key] : void 0;
        let _fetch = envFetch || fetch;
        responseType = responseType ? (responseType + "").toLowerCase() : "text";
        let composedSignal = composeSignals([signal, cancelToken && cancelToken.toAbortSignal()], timeout);
        let request = null;
        const unsubscribe = composedSignal && composedSignal.unsubscribe && (() => {
          composedSignal.unsubscribe();
        });
        let requestContentLength;
        let pendingBodyError = null;
        const maxBodyLengthError = () => new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config, request);
        try {
          let auth = void 0;
          const configAuth = own2("auth");
          if (configAuth) {
            const username = utils$1.getSafeProp(configAuth, "username") || "";
            const password = utils$1.getSafeProp(configAuth, "password") || "";
            auth = {
              username,
              password
            };
          }
          if (maybeWithAuthCredentials(url2)) {
            const parsedURL = new URL(url2, platform.origin);
            if (!auth && (parsedURL.username || parsedURL.password)) {
              const urlUsername = decodeURIComponentSafe(parsedURL.username);
              const urlPassword = decodeURIComponentSafe(parsedURL.password);
              auth = {
                username: urlUsername,
                password: urlPassword
              };
            }
            if (parsedURL.username || parsedURL.password) {
              parsedURL.username = "";
              parsedURL.password = "";
              url2 = parsedURL.href;
            }
          }
          if (auth) {
            headers.delete("authorization");
            headers.set("Authorization", "Basic " + btoa(encodeUTF8((auth.username || "") + ":" + (auth.password || ""))));
          }
          if (hasMaxContentLength && typeof url2 === "string" && url2.startsWith("data:")) {
            const estimated = estimateDataURLDecodedBytes(url2);
            if (estimated > maxContentLength) {
              throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
            }
          }
          if (hasMaxBodyLength && method !== "get" && method !== "head") {
            const outboundLength = await getBodyLength(data);
            if (typeof outboundLength === "number" && isFinite(outboundLength)) {
              requestContentLength = outboundLength;
              if (outboundLength > maxBodyLength) {
                throw maxBodyLengthError();
              }
            }
          }
          const mustEnforceStreamBody = hasMaxBodyLength && (utils$1.isReadableStream(data) || utils$1.isStream(data));
          const trackRequestStream = (stream2, onProgress, flush) => trackStream(stream2, DEFAULT_CHUNK_SIZE, (loadedBytes) => {
            if (hasMaxBodyLength && loadedBytes > maxBodyLength) {
              throw pendingBodyError = maxBodyLengthError();
            }
            onProgress && onProgress(loadedBytes);
          }, flush);
          if (supportsRequestStream && method !== "get" && method !== "head" && (onUploadProgress || mustEnforceStreamBody)) {
            requestContentLength = requestContentLength == null ? await resolveBodyLength(headers, data) : requestContentLength;
            if (requestContentLength !== 0 || mustEnforceStreamBody) {
              let _request = new Request(url2, {
                method: "POST",
                body: data,
                duplex: "half"
              });
              let contentTypeHeader;
              if (utils$1.isFormData(data) && (contentTypeHeader = _request.headers.get("content-type"))) {
                headers.setContentType(contentTypeHeader);
              }
              if (_request.body) {
                const [onProgress, flush] = onUploadProgress && progressEventDecorator(requestContentLength, progressEventReducer(asyncDecorator(onUploadProgress))) || [];
                data = trackRequestStream(_request.body, onProgress, flush);
              }
            }
          } else if (mustEnforceStreamBody && !isRequestSupported && isReadableStreamSupported && method !== "get" && method !== "head") {
            data = trackRequestStream(data);
          } else if (mustEnforceStreamBody && isRequestSupported && !supportsRequestStream && method !== "get" && method !== "head") {
            throw new AxiosError("Stream request bodies are not supported by the current fetch implementation", AxiosError.ERR_NOT_SUPPORT, config, request);
          }
          if (!utils$1.isString(withCredentials)) {
            withCredentials = withCredentials ? "include" : "omit";
          }
          const isCredentialsSupported = isRequestSupported && "credentials" in Request.prototype;
          if (utils$1.isFormData(data)) {
            const contentType = headers.getContentType();
            if (contentType && /^multipart\/form-data/i.test(contentType) && !/boundary=/i.test(contentType)) {
              headers.delete("content-type");
            }
          }
          headers.set("User-Agent", "axios/" + VERSION, false);
          const safeFetchOptions = fetchOptions == null ? fetchOptions : Object.assign(/* @__PURE__ */ Object.create(null), fetchOptions);
          if (safeFetchOptions) {
            delete safeFetchOptions.body;
            delete safeFetchOptions.headers;
            delete safeFetchOptions.method;
            delete safeFetchOptions.signal;
            delete safeFetchOptions.duplex;
            delete safeFetchOptions.credentials;
          }
          const resolvedOptions = Object.assign(/* @__PURE__ */ Object.create(null), safeFetchOptions, {
            signal: composedSignal,
            method: method.toUpperCase(),
            headers: toByteStringHeaderObject(headers.normalize()),
            body: data,
            duplex: "half",
            credentials: isCredentialsSupported ? withCredentials : void 0
          });
          if (isRequestSupported) {
            utils$1.forEach(DEFAULT_REQUEST_OPTIONS, (value, key) => {
              if (resolvedOptions[key] === void 0) {
                resolvedOptions[key] = value;
              }
            });
            if (resolvedOptions.signal === void 0) {
              resolvedOptions.signal = null;
            }
            if (resolvedOptions.body === void 0) {
              resolvedOptions.body = null;
            }
          }
          if (maxRedirects === 0) {
            resolvedOptions.redirect = "manual";
            if (safeFetchOptions) {
              safeFetchOptions.redirect = "manual";
            }
          }
          request = isRequestSupported && new Request(url2, resolvedOptions);
          let response = await (isRequestSupported ? _fetch(request, safeFetchOptions) : _fetch(url2, resolvedOptions));
          const responseHeaders = AxiosHeaders.from(response.headers);
          if (hasMaxContentLength) {
            const declaredLength = utils$1.toFiniteNumber(responseHeaders.getContentLength());
            if (declaredLength != null && declaredLength > maxContentLength) {
              throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
            }
          }
          const isStreamResponse = supportsResponseStream && (responseType === "stream" || responseType === "response");
          if (supportsResponseStream && response.body && (onDownloadProgress || hasMaxContentLength || isStreamResponse && unsubscribe)) {
            const options = {};
            ["status", "statusText", "headers"].forEach((prop) => {
              options[prop] = response[prop];
            });
            const responseContentLength = utils$1.toFiniteNumber(responseHeaders.getContentLength());
            const [onProgress, flush] = onDownloadProgress && progressEventDecorator(responseContentLength, progressEventReducer(asyncDecorator(onDownloadProgress), true)) || [];
            let bytesRead = 0;
            const onChunkProgress = (loadedBytes) => {
              if (hasMaxContentLength) {
                bytesRead = loadedBytes;
                if (bytesRead > maxContentLength) {
                  throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
                }
              }
              onProgress && onProgress(loadedBytes);
            };
            response = new Response(trackStream(response.body, DEFAULT_CHUNK_SIZE, onChunkProgress, () => {
              flush && flush();
              unsubscribe && unsubscribe();
            }), options);
          }
          responseType = responseType || "text";
          let responseData = await resolvers[utils$1.findKey(resolvers, responseType) || "text"](response, config);
          if (hasMaxContentLength && !supportsResponseStream && !isStreamResponse) {
            let materializedSize;
            if (responseData != null) {
              if (typeof responseData.byteLength === "number") {
                materializedSize = responseData.byteLength;
              } else if (typeof responseData.size === "number") {
                materializedSize = responseData.size;
              } else if (typeof responseData === "string") {
                materializedSize = typeof TextEncoder2 === "function" ? new TextEncoder2().encode(responseData).byteLength : responseData.length;
              }
            }
            if (typeof materializedSize === "number" && materializedSize > maxContentLength) {
              throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
            }
          }
          !isStreamResponse && unsubscribe && unsubscribe();
          return await new Promise((resolve, reject) => {
            settle(resolve, reject, {
              data: responseData,
              headers: AxiosHeaders.from(response.headers),
              status: response.status,
              statusText: response.statusText,
              config,
              request
            });
          });
        } catch (err) {
          unsubscribe && unsubscribe();
          if (composedSignal && composedSignal.aborted && composedSignal.reason instanceof AxiosError) {
            const canceledError = composedSignal.reason;
            canceledError.config = config;
            request && (canceledError.request = request);
            if (err !== canceledError) {
              Object.defineProperty(canceledError, "cause", {
                __proto__: null,
                value: err,
                writable: true,
                enumerable: false,
                configurable: true
              });
            }
            throw canceledError;
          }
          if (pendingBodyError) {
            request && !pendingBodyError.request && (pendingBodyError.request = request);
            throw pendingBodyError;
          }
          if (err instanceof AxiosError) {
            request && !err.request && (err.request = request);
            throw err;
          }
          if (err && err.name === "TypeError" && /Load failed|fetch/i.test(err.message)) {
            const networkError = new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, request, err && err.response);
            Object.defineProperty(networkError, "cause", {
              __proto__: null,
              value: err.cause || err,
              writable: true,
              enumerable: false,
              configurable: true
            });
            throw networkError;
          }
          throw AxiosError.from(err, err && err.code, config, request, err && err.response);
        }
      };
    };
    var seedCache = /* @__PURE__ */ new Map();
    var getFetch = (config) => {
      let env = config && config.env || {};
      const {
        fetch: fetch2,
        Request,
        Response
      } = env;
      const seeds = [Request, Response, fetch2];
      let len = seeds.length, i = len, seed, target, map = seedCache;
      while (i--) {
        seed = seeds[i];
        target = map.get(seed);
        target === void 0 && map.set(seed, target = i ? /* @__PURE__ */ new Map() : factory(env));
        map = target;
      }
      return target;
    };
    getFetch();
    var knownAdapters = {
      http: httpAdapter,
      xhr: xhrAdapter,
      fetch: {
        get: getFetch
      }
    };
    utils$1.forEach(knownAdapters, (fn, value) => {
      if (fn) {
        try {
          Object.defineProperty(fn, "name", {
            __proto__: null,
            value
          });
        } catch (e) {
        }
        Object.defineProperty(fn, "adapterName", {
          __proto__: null,
          value
        });
      }
    });
    var renderReason = (reason) => `- ${reason}`;
    var isResolvedHandle = (adapter) => utils$1.isFunction(adapter) || adapter === null || adapter === false;
    function getAdapter(adapters2, config) {
      adapters2 = utils$1.isArray(adapters2) ? adapters2 : [adapters2];
      const {
        length
      } = adapters2;
      let nameOrAdapter;
      let adapter;
      const rejectedReasons = {};
      for (let i = 0; i < length; i++) {
        nameOrAdapter = adapters2[i];
        let id;
        adapter = nameOrAdapter;
        if (!isResolvedHandle(nameOrAdapter)) {
          adapter = knownAdapters[(id = String(nameOrAdapter)).toLowerCase()];
          if (adapter === void 0) {
            throw new AxiosError(`Unknown adapter '${id}'`);
          }
        }
        if (adapter && (utils$1.isFunction(adapter) || (adapter = adapter.get(config)))) {
          break;
        }
        rejectedReasons[id || "#" + i] = adapter;
      }
      if (!adapter) {
        const reasons = Object.entries(rejectedReasons).map(([id, state]) => `adapter ${id} ` + (state === false ? "is not supported by the environment" : "is not available in the build"));
        let s = length ? reasons.length > 1 ? "since :\n" + reasons.map(renderReason).join("\n") : " " + renderReason(reasons[0]) : "as no adapter specified";
        throw new AxiosError(`There is no suitable adapter to dispatch the request ` + s, AxiosError.ERR_NOT_SUPPORT);
      }
      return adapter;
    }
    var adapters = {
      /**
       * Resolve an adapter from a list of adapter names or functions.
       * @type {Function}
       */
      getAdapter,
      /**
       * Exposes all known adapters
       * @type {Object<string, Function|Object>}
       */
      adapters: knownAdapters
    };
    function throwIfCancellationRequested(config) {
      if (config.cancelToken) {
        config.cancelToken.throwIfRequested();
      }
      if (config.signal && config.signal.aborted) {
        throw new CanceledError(null, config);
      }
    }
    function dispatchRequest(_config) {
      const config = utils$1.toSafeFlatObject(_config);
      throwIfCancellationRequested(config);
      config.headers = AxiosHeaders.from(utils$1.getSafeProp(config, "headers"));
      config.data = transformData.call(config, config.transformRequest);
      if (["post", "put", "patch"].indexOf(config.method) !== -1) {
        config.headers.setContentType("application/x-www-form-urlencoded", false);
      }
      const adapter = adapters.getAdapter(config.adapter || defaults.adapter, config);
      return adapter(config).then(function onAdapterResolution(response) {
        throwIfCancellationRequested(config);
        config.response = response;
        try {
          response.data = transformData.call(config, config.transformResponse, response);
        } finally {
          delete config.response;
        }
        response.headers = AxiosHeaders.from(response.headers);
        return response;
      }, function onAdapterRejection(reason) {
        if (!isCancel(reason)) {
          throwIfCancellationRequested(config);
          if (reason && reason.response) {
            config.response = reason.response;
            try {
              reason.response.data = transformData.call(config, config.transformResponse, reason.response);
            } finally {
              delete config.response;
            }
            reason.response.headers = AxiosHeaders.from(reason.response.headers);
          }
        }
        return Promise.reject(reason);
      });
    }
    var validators$1 = {};
    ["object", "boolean", "number", "function", "string", "symbol"].forEach((type, i) => {
      validators$1[type] = function validator2(thing) {
        return typeof thing === type || "a" + (i < 1 ? "n " : " ") + type;
      };
    });
    var deprecatedWarnings = {};
    validators$1.transitional = function transitional(validator2, version, message) {
      function formatMessage(opt, desc) {
        return "[Axios v" + VERSION + "] Transitional option '" + opt + "'" + desc + (message ? ". " + message : "");
      }
      return (value, opt, opts) => {
        if (validator2 === false) {
          throw new AxiosError(formatMessage(opt, " has been removed" + (version ? " in " + version : "")), AxiosError.ERR_DEPRECATED);
        }
        if (version && !deprecatedWarnings[opt]) {
          deprecatedWarnings[opt] = true;
          console.warn(formatMessage(opt, " has been deprecated since v" + version + " and will be removed in the near future"));
        }
        return validator2 ? validator2(value, opt, opts) : true;
      };
    };
    validators$1.spelling = function spelling(correctSpelling) {
      return (value, opt) => {
        console.warn(`${opt} is likely a misspelling of ${correctSpelling}`);
        return true;
      };
    };
    function assertOptions(options, schema, allowUnknown) {
      if (typeof options !== "object" || options === null) {
        throw new AxiosError("options must be an object", AxiosError.ERR_BAD_OPTION_VALUE);
      }
      const keys = Object.keys(options);
      let i = keys.length;
      while (i-- > 0) {
        const opt = keys[i];
        const validator2 = Object.prototype.hasOwnProperty.call(schema, opt) ? schema[opt] : void 0;
        if (validator2) {
          const value = options[opt];
          const result = value === void 0 || validator2(value, opt, options);
          if (result !== true) {
            throw new AxiosError("option " + opt + " must be " + result, AxiosError.ERR_BAD_OPTION_VALUE);
          }
          continue;
        }
        if (allowUnknown !== true) {
          throw new AxiosError("Unknown option " + opt, AxiosError.ERR_BAD_OPTION);
        }
      }
    }
    var validator = {
      assertOptions,
      validators: validators$1
    };
    var validators = validator.validators;
    var Axios = class {
      constructor(instanceConfig) {
        this.defaults = instanceConfig || {};
        this.interceptors = {
          request: new InterceptorManager(),
          response: new InterceptorManager()
        };
      }
      /**
       * Dispatch a request
       *
       * @param {String|Object} configOrUrl The config specific for this request (merged with this.defaults)
       * @param {?Object} config
       *
       * @returns {Promise} The Promise to be fulfilled
       */
      async request(configOrUrl, config) {
        try {
          return await this._request(configOrUrl, config);
        } catch (err) {
          if (err instanceof Error) {
            try {
              let dummy = {};
              Error.captureStackTrace ? Error.captureStackTrace(dummy) : dummy = new Error();
              const dummyStack = dummy.stack;
              let stack = "";
              if (typeof dummyStack === "string") {
                const firstNewlineIndex = dummyStack.indexOf("\n");
                stack = firstNewlineIndex === -1 ? "" : dummyStack.slice(firstNewlineIndex + 1);
              }
              if (!err.stack) {
                err.stack = stack;
              } else if (stack) {
                const firstNewlineIndex = stack.indexOf("\n");
                const secondNewlineIndex = firstNewlineIndex === -1 ? -1 : stack.indexOf("\n", firstNewlineIndex + 1);
                const stackWithoutTwoTopLines = secondNewlineIndex === -1 ? "" : stack.slice(secondNewlineIndex + 1);
                if (!String(err.stack).endsWith(stackWithoutTwoTopLines)) {
                  err.stack += "\n" + stack;
                }
              }
            } catch (e) {
            }
          }
          throw err;
        }
      }
      _request(configOrUrl, config) {
        if (typeof configOrUrl === "string") {
          config = config || {};
          config.url = configOrUrl;
        } else {
          config = configOrUrl || {};
        }
        config = mergeConfig(this.defaults, config);
        const {
          transitional,
          paramsSerializer,
          headers
        } = config;
        if (transitional !== void 0) {
          validator.assertOptions(transitional, {
            silentJSONParsing: validators.transitional(validators.boolean),
            forcedJSONParsing: validators.transitional(validators.boolean),
            clarifyTimeoutError: validators.transitional(validators.boolean),
            legacyInterceptorReqResOrdering: validators.transitional(validators.boolean),
            advertiseZstdAcceptEncoding: validators.transitional(validators.boolean),
            validateStatusUndefinedResolves: validators.transitional(validators.boolean)
          }, false);
        }
        if (paramsSerializer != null) {
          if (utils$1.isFunction(paramsSerializer)) {
            config.paramsSerializer = {
              serialize: paramsSerializer
            };
          } else {
            validator.assertOptions(paramsSerializer, {
              encode: validators.function,
              serialize: validators.function
            }, true);
          }
        }
        if (config.allowAbsoluteUrls !== void 0) ;
        else if (this.defaults.allowAbsoluteUrls !== void 0) {
          config.allowAbsoluteUrls = this.defaults.allowAbsoluteUrls;
        } else {
          config.allowAbsoluteUrls = true;
        }
        validator.assertOptions(config, {
          baseUrl: validators.spelling("baseURL"),
          withXsrfToken: validators.spelling("withXSRFToken")
        }, true);
        config.method = (utils$1.getSafeProp(config, "method") || utils$1.getSafeProp(this.defaults, "method") || "get").toLowerCase();
        let contextHeaders = headers && utils$1.merge(headers.common, headers[config.method]);
        headers && utils$1.forEach(methodList.concat("common"), (method) => {
          delete headers[method];
        });
        config.headers = AxiosHeaders.concat(contextHeaders, headers);
        const requestInterceptorChain = [];
        let synchronousRequestInterceptors = true;
        this.interceptors.request.forEach(function unshiftRequestInterceptors(interceptor) {
          if (typeof interceptor.runWhen === "function" && interceptor.runWhen(config) === false) {
            return;
          }
          synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;
          const transitional2 = config.transitional || transitionalDefaults;
          const legacyInterceptorReqResOrdering = transitional2 && transitional2.legacyInterceptorReqResOrdering;
          if (legacyInterceptorReqResOrdering) {
            requestInterceptorChain.unshift(interceptor.fulfilled, interceptor.rejected);
          } else {
            requestInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
          }
        });
        const responseInterceptorChain = [];
        this.interceptors.response.forEach(function pushResponseInterceptors(interceptor) {
          responseInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
        });
        let promise;
        let i = 0;
        let len;
        if (!synchronousRequestInterceptors) {
          const chain = [dispatchRequest.bind(this), void 0];
          chain.unshift(...requestInterceptorChain);
          chain.push(...responseInterceptorChain);
          len = chain.length;
          promise = Promise.resolve(config);
          while (i < len) {
            promise = promise.then(chain[i++], chain[i++]);
          }
          return promise;
        }
        len = requestInterceptorChain.length;
        let newConfig = config;
        while (i < len) {
          const onFulfilled = requestInterceptorChain[i++];
          const onRejected = requestInterceptorChain[i++];
          try {
            newConfig = onFulfilled ? onFulfilled(newConfig) : newConfig;
          } catch (error) {
            if (!onRejected) {
              promise = Promise.reject(error);
              break;
            }
            try {
              const rejectedResult = onRejected.call(this, error);
              if (utils$1.isThenable(rejectedResult)) {
                promise = Promise.resolve(rejectedResult).then(() => dispatchRequest.call(this, newConfig));
              }
            } catch (rejectedError) {
              promise = Promise.reject(rejectedError);
            }
            break;
          }
        }
        if (!promise) {
          try {
            promise = dispatchRequest.call(this, newConfig);
          } catch (error) {
            promise = Promise.reject(error);
          }
        }
        i = 0;
        len = responseInterceptorChain.length;
        while (i < len) {
          promise = promise.then(responseInterceptorChain[i++], responseInterceptorChain[i++]);
        }
        return promise;
      }
      getUri(config) {
        config = mergeConfig(this.defaults, config);
        const fullPath = buildFullPath(config.baseURL, config.url, config.allowAbsoluteUrls, config);
        return buildURL(fullPath, config.params, config.paramsSerializer);
      }
    };
    utils$1.forEach(["delete", "get", "head", "options"], function forEachMethodNoData(method) {
      Axios.prototype[method] = function(url2, config) {
        return this.request(mergeConfig(config || {}, {
          method,
          url: url2,
          data: config && utils$1.hasOwnProp(config, "data") ? config.data : void 0
        }));
      };
    });
    utils$1.forEach(["post", "put", "patch", "query"], function forEachMethodWithData(method) {
      function generateHTTPMethod(isForm) {
        return function httpMethod(url2, data, config) {
          return this.request(mergeConfig(config || {}, {
            method,
            headers: isForm ? {
              "Content-Type": "multipart/form-data"
            } : {},
            url: url2,
            data
          }));
        };
      }
      Axios.prototype[method] = generateHTTPMethod();
      if (method !== "query") {
        Axios.prototype[method + "Form"] = generateHTTPMethod(true);
      }
    });
    var CancelToken = class _CancelToken {
      constructor(executor) {
        if (typeof executor !== "function") {
          throw new TypeError("executor must be a function.");
        }
        let resolvePromise;
        this.promise = new Promise(function promiseExecutor(resolve) {
          resolvePromise = resolve;
        });
        const token = this;
        this.promise.then((cancel) => {
          if (!token._listeners) return;
          let i = token._listeners.length;
          while (i-- > 0) {
            token._listeners[i](cancel);
          }
          token._listeners = null;
        });
        this.promise.then = (onfulfilled) => {
          let _resolve;
          const promise = new Promise((resolve) => {
            token.subscribe(resolve);
            _resolve = resolve;
          }).then(onfulfilled);
          promise.cancel = function reject() {
            token.unsubscribe(_resolve);
          };
          return promise;
        };
        executor(function cancel(message, config, request) {
          if (token.reason) {
            return;
          }
          token.reason = new CanceledError(message, config, request);
          resolvePromise(token.reason);
        });
      }
      /**
       * Throws a `CanceledError` if cancellation has been requested.
       */
      throwIfRequested() {
        if (this.reason) {
          throw this.reason;
        }
      }
      /**
       * Subscribe to the cancel signal
       */
      subscribe(listener) {
        if (this.reason) {
          listener(this.reason);
          return;
        }
        if (this._listeners) {
          this._listeners.push(listener);
        } else {
          this._listeners = [listener];
        }
      }
      /**
       * Unsubscribe from the cancel signal
       */
      unsubscribe(listener) {
        if (!this._listeners) {
          return;
        }
        const index = this._listeners.indexOf(listener);
        if (index !== -1) {
          this._listeners.splice(index, 1);
        }
      }
      toAbortSignal() {
        const controller = new AbortController();
        const abort = (err) => {
          controller.abort(err);
        };
        this.subscribe(abort);
        controller.signal.unsubscribe = () => this.unsubscribe(abort);
        return controller.signal;
      }
      /**
       * Returns an object that contains a new `CancelToken` and a function that, when called,
       * cancels the `CancelToken`.
       */
      static source() {
        let cancel;
        const token = new _CancelToken(function executor(c) {
          cancel = c;
        });
        return {
          token,
          cancel
        };
      }
    };
    function spread(callback) {
      return function wrap(arr) {
        return callback.apply(null, arr);
      };
    }
    function isAxiosError(payload) {
      return utils$1.isObject(payload) && payload.isAxiosError === true;
    }
    var HttpStatusCode = {
      Continue: 100,
      SwitchingProtocols: 101,
      Processing: 102,
      EarlyHints: 103,
      Ok: 200,
      Created: 201,
      Accepted: 202,
      NonAuthoritativeInformation: 203,
      NoContent: 204,
      ResetContent: 205,
      PartialContent: 206,
      MultiStatus: 207,
      AlreadyReported: 208,
      ImUsed: 226,
      MultipleChoices: 300,
      MovedPermanently: 301,
      Found: 302,
      SeeOther: 303,
      NotModified: 304,
      UseProxy: 305,
      Unused: 306,
      TemporaryRedirect: 307,
      PermanentRedirect: 308,
      BadRequest: 400,
      Unauthorized: 401,
      PaymentRequired: 402,
      Forbidden: 403,
      NotFound: 404,
      MethodNotAllowed: 405,
      NotAcceptable: 406,
      ProxyAuthenticationRequired: 407,
      RequestTimeout: 408,
      Conflict: 409,
      Gone: 410,
      LengthRequired: 411,
      PreconditionFailed: 412,
      /**
       * @deprecated Use `ContentTooLarge` instead.
       */
      PayloadTooLarge: 413,
      ContentTooLarge: 413,
      UriTooLong: 414,
      UnsupportedMediaType: 415,
      RangeNotSatisfiable: 416,
      ExpectationFailed: 417,
      ImATeapot: 418,
      MisdirectedRequest: 421,
      /**
       * @deprecated Use `UnprocessableContent` instead.
       */
      UnprocessableEntity: 422,
      UnprocessableContent: 422,
      Locked: 423,
      FailedDependency: 424,
      TooEarly: 425,
      UpgradeRequired: 426,
      PreconditionRequired: 428,
      TooManyRequests: 429,
      RequestHeaderFieldsTooLarge: 431,
      UnavailableForLegalReasons: 451,
      InternalServerError: 500,
      NotImplemented: 501,
      BadGateway: 502,
      ServiceUnavailable: 503,
      GatewayTimeout: 504,
      HttpVersionNotSupported: 505,
      VariantAlsoNegotiates: 506,
      InsufficientStorage: 507,
      LoopDetected: 508,
      NotExtended: 510,
      NetworkAuthenticationRequired: 511,
      WebServerReturnsAnUnknownError: 520,
      WebServerIsDown: 521,
      ConnectionTimedOut: 522,
      OriginIsUnreachable: 523,
      TimeoutOccurred: 524,
      SslHandshakeFailed: 525,
      InvalidSslCertificate: 526
    };
    Object.entries(HttpStatusCode).forEach(([key, value]) => {
      if (HttpStatusCode[value] === void 0) {
        HttpStatusCode[value] = key;
      }
    });
    function createInstance(defaultConfig) {
      const context = new Axios(defaultConfig);
      const instance = bind(Axios.prototype.request, context);
      utils$1.extend(instance, Axios.prototype, context, {
        allOwnKeys: true
      });
      utils$1.extend(instance, context, null, {
        allOwnKeys: true
      });
      instance.create = function create(instanceConfig) {
        return createInstance(mergeConfig(defaultConfig, instanceConfig));
      };
      return instance;
    }
    var axios2 = createInstance(defaults);
    axios2.Axios = Axios;
    axios2.CanceledError = CanceledError;
    axios2.CancelToken = CancelToken;
    axios2.isCancel = isCancel;
    axios2.VERSION = VERSION;
    axios2.toFormData = toFormData;
    axios2.AxiosError = AxiosError;
    axios2.Cancel = axios2.CanceledError;
    axios2.all = function all(promises) {
      return Promise.all(promises);
    };
    axios2.spread = spread;
    axios2.isAxiosError = isAxiosError;
    axios2.mergeConfig = mergeConfig;
    axios2.AxiosHeaders = AxiosHeaders;
    axios2.formToJSON = (thing) => formDataToJSON(utils$1.isHTMLForm(thing) ? new FormData(thing) : thing);
    axios2.getAdapter = adapters.getAdapter;
    axios2.HttpStatusCode = HttpStatusCode;
    axios2.default = axios2;
    module2.exports = axios2;
  }
});

// src/native/download-quality.js
var require_download_quality = __commonJS({
  "src/native/download-quality.js"(exports2, module2) {
    var DOWNLOAD_QUALITIES = ["auto", "1080p", "720p"];
    function normalizeDownloadQuality2(value = "auto") {
      if (!DOWNLOAD_QUALITIES.includes(value)) throw new Error("\u4E0B\u8F7D\u6E05\u6670\u5EA6\u65E0\u6548\uFF0C\u8BF7\u9009\u62E9\u81EA\u52A8\u30011080p \u6216 720p");
      return value;
    }
    function meetsDownloadQuality({ width, height } = {}, quality = "auto") {
      quality = normalizeDownloadQuality2(quality);
      if (quality === "auto") return true;
      const dimensions = [Number(width), Number(height)];
      return dimensions.every((value) => Number.isFinite(value) && value > 0) && Math.min(...dimensions) >= Number.parseInt(quality, 10);
    }
    module2.exports = { normalizeDownloadQuality: normalizeDownloadQuality2, meetsDownloadQuality };
  }
});

// src/native/web-media-guard.js
var require_web_media_guard = __commonJS({
  "src/native/web-media-guard.js"(exports2, module2) {
    var { isIP, BlockList } = require("node:net");
    var dns = require("node:dns");
    var http = require("node:http");
    var https = require("node:https");
    function guardedAgent(Agent) {
      const agent = new Agent({ keepAlive: true });
      const getName = agent.getName;
      const proxyRoute = /* @__PURE__ */ Symbol("proxyRoute");
      agent.addRequest = (request, options) => Agent.prototype.addRequest.call(
        agent,
        request,
        { ...options, [proxyRoute]: /^https?:\/\//i.test(request.path) }
      );
      agent.getName = (options) => `${getName.call(agent, options)}:${options[proxyRoute] ? "proxy" : "direct"}`;
      return agent;
    }
    var httpAgent = guardedAgent(http.Agent);
    var httpsAgent = guardedAgent(https.Agent);
    var trustedOfficialHttpsAgent = guardedAgent(https.Agent);
    var blocked = new BlockList();
    for (const [address, prefix] of [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 3]
    ]) {
      blocked.addSubnet(address, prefix, "ipv4");
    }
    for (const [address, prefix] of [["2001:db8::", 32], ["2001::", 32], ["2002::", 16]]) {
      blocked.addSubnet(address, prefix, "ipv6");
    }
    var globalV6 = new BlockList();
    globalV6.addSubnet("2000::", 3, "ipv6");
    globalV6.addSubnet("::ffff:0:0", 96, "ipv6");
    var fakeV4 = new BlockList();
    fakeV4.addSubnet("198.18.0.0", 15, "ipv4");
    function isPublicAddress(address) {
      const family = isIP(address);
      return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
    }
    var isFakeAddress = (address) => isIP(address) === 4 && fakeV4.check(address, "ipv4");
    function isPublicMediaUrl2(value) {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
        const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
        if (isIP(host)) return isPublicAddress(host);
        return host.includes(".") && !/(^|\.)(localhost|local|internal|lan|home)$/.test(host);
      } catch (_) {
        return false;
      }
    }
    function blockedAddress() {
      return Object.assign(new Error("\u5B98\u7F51\u7247\u6E90\u53CA\u5176\u8DF3\u8F6C\u3001\u89E3\u6790\u7ED3\u679C\u5FC5\u987B\u6307\u5411\u516C\u7F51"), { code: "ERR_WEB_MEDIA_ADDRESS", mediaRetryable: true });
    }
    var publicDnsCache = /* @__PURE__ */ new Map();
    var publicDnsPending = /* @__PURE__ */ new Map();
    function resolvePublicAddresses(hostname) {
      const key = hostname.toLowerCase();
      const cached = publicDnsCache.get(key);
      if (cached?.expires > Date.now()) return Promise.resolve(cached.addresses);
      if (publicDnsPending.has(key)) return publicDnsPending.get(key);
      const requests = [];
      const pending = Promise.any(["https://1.1.1.1/dns-query", "https://223.5.5.5/resolve"].map((endpoint) => new Promise((resolve, reject) => {
        const request = https.get(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, {
          agent: new https.Agent({ keepAlive: false }),
          headers: { Accept: "application/dns-json" }
        }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("error", reject);
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536) request.destroy(blockedAddress());
          });
          response.on("end", () => {
            try {
              const data = JSON.parse(body);
              const rows = (data.Answer || []).filter((item) => item.type === 1);
              if (response.statusCode !== 200 || data.Status !== 0 || !rows.length || rows.some((item) => isIP(item.data) !== 4 || !isPublicAddress(item.data))) throw blockedAddress();
              const addresses = rows.map((item) => ({ address: item.data, family: 4 }));
              const ttl = Math.max(0, Math.min(60, ...rows.map((item) => Number(item.TTL) || 0)));
              resolve({ addresses, expires: Date.now() + ttl * 1e3 });
            } catch (_) {
              reject(blockedAddress());
            }
          });
        });
        requests.push(request);
        const timer = setTimeout(() => request.destroy(Object.assign(new Error("\u5B98\u7F51\u5B89\u5168 DNS \u89E3\u6790\u8D85\u65F6"), { code: "ETIMEDOUT" })), 4e3);
        request.on("close", () => clearTimeout(timer));
        request.on("error", reject);
      }))).then((result) => {
        publicDnsCache.set(key, result);
        return result.addresses;
      }).catch((error) => {
        throw error.errors?.find((item) => item.code === "ERR_WEB_MEDIA_ADDRESS") || error.errors?.[0] || error;
      }).finally(() => {
        requests.forEach((request) => request.destroy());
        publicDnsPending.delete(key);
      });
      publicDnsPending.set(key, pending);
      return pending;
    }
    function webMediaRequestOptions2(value, { trustedOfficialDns = false } = {}) {
      if (!isPublicMediaUrl2(value)) throw blockedAddress();
      const initial = new URL(value);
      if (trustedOfficialDns && initial.origin !== "https://hongguoduanju.com") throw blockedAddress();
      const hosts = /* @__PURE__ */ new Map([[initial.hostname.toLowerCase(), initial]]);
      return {
        maxRedirects: 5,
        // Reuse only this guard's sockets; new connections still run the request's checked lookup.
        httpAgent,
        httpsAgent: trustedOfficialDns ? trustedOfficialHttpsAgent : httpsAgent,
        ...trustedOfficialDns ? { proxy: false } : {},
        lookup(hostname, options, callback) {
          const settings = typeof options === "number" ? { family: options } : options || {};
          const finish = (addresses) => {
            if (settings.all) callback(null, addresses);
            else if (addresses.length) callback(null, addresses[0].address, addresses[0].family);
            else callback(new Error("\u7247\u6E90\u57DF\u540D\u672A\u89E3\u6790\u5230\u5730\u5740"));
          };
          const target = hosts.get(hostname.toLowerCase());
          const official = target?.origin === "https://hongguoduanju.com";
          if (official && trustedOfficialDns) {
            if (settings.family === 6) return callback(blockedAddress());
            resolvePublicAddresses(hostname).then(finish, callback);
            return;
          }
          dns.lookup(hostname, { ...settings, all: true }, (error, addresses) => {
            if (error) return callback(error);
            if (target && (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))) {
              const fakeOnly = addresses.length > 0 && addresses.every((item) => isFakeAddress(item.address));
              if (fakeOnly && target.protocol === "https:" && settings.family !== 6) {
                resolvePublicAddresses(hostname).then(finish, callback);
                return;
              }
              return callback(blockedAddress());
            }
            finish(addresses);
          });
        },
        beforeRedirect(_options, response, request) {
          const target = new URL(response.headers.location, request.url);
          if (!isPublicMediaUrl2(target.href)) throw blockedAddress();
          hosts.set(target.hostname.toLowerCase(), target);
        }
      };
    }
    function warmOfficialDns() {
      return resolvePublicAddresses("hongguoduanju.com").catch(() => {
      });
    }
    module2.exports = { isPublicMediaUrl: isPublicMediaUrl2, webMediaRequestOptions: webMediaRequestOptions2, warmOfficialDns };
  }
});

// src/native/request-signal.js
var require_request_signal = __commonJS({
  "src/native/request-signal.js"(exports2, module2) {
    function abortError2(signal) {
      const timeout = signal?.reason?.name === "TimeoutError";
      return Object.assign(new Error(timeout ? "App \u7247\u6E90\u8BF7\u6C42\u8D85\u65F6" : "\u5DF2\u53D6\u6D88 App \u7247\u6E90\u8BF7\u6C42"), {
        code: timeout ? "ETIMEDOUT" : "ERR_CANCELED"
      });
    }
    function throwIfAborted2(signal) {
      if (signal?.aborted) throw abortError2(signal);
    }
    function boundedSignal(parent, timeout) {
      const controller = new AbortController();
      const timeoutReason = () => Object.assign(new Error("App \u7247\u6E90\u8BF7\u6C42\u8D85\u65F6"), { name: "TimeoutError" });
      const abort = () => controller.abort(parent?.reason?.name === "TimeoutError" ? timeoutReason() : void 0);
      let timer;
      if (parent?.aborted) abort();
      else {
        parent?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => controller.abort(timeoutReason()), timeout);
        timer.unref?.();
      }
      return { signal: controller.signal, dispose() {
        clearTimeout(timer);
        parent?.removeEventListener("abort", abort);
      } };
    }
    function networkFailure(code) {
      if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "DNS";
      if (["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ECONNABORTED"].includes(code)) return "CONNECTION";
      if ([
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
        "ERR_SSL_WRONG_VERSION_NUMBER",
        "EPROTO"
      ].includes(code)) return "TLS";
      return void 0;
    }
    module2.exports = { abortError: abortError2, throwIfAborted: throwIfAborted2, boundedSignal, networkFailure };
  }
});

// src/native/catalog.js
var require_catalog = __commonJS({
  "src/native/catalog.js"(exports2, module2) {
    var axios2 = require_axios();
    var net;
    if (process.versions.electron && process.type === "browser") ({ net } = require("electron"));
    var { webMediaRequestOptions: webMediaRequestOptions2 } = require_web_media_guard();
    var SITE = "https://hongguoduanju.com";
    var CATEGORIES = /* @__PURE__ */ new Set(["real-drama", "comic-drama", "ai-drama", "comic"]);
    var RANKINGS = /* @__PURE__ */ new Set(["hot-drama", "hot-real-drama", "hot-comic-drama", "hot-ai-drama"]);
    var TIMEOUT_MS = 1e4;
    var MAX_PAGE_BYTES = 8 * 1024 * 1024;
    var CACHE_MS = 12e4;
    var cache = /* @__PURE__ */ new Map();
    var pending = /* @__PURE__ */ new Map();
    function publicMetadata(item) {
      const episode_label = typeof item?.episode_right_text === "string" ? item.episode_right_text.trim().slice(0, 80) : "";
      const completion_status = /^(?:全\s*\d+\s*集|已完结|完结)$/.test(episode_label) ? "completed" : /连载|更新至\s*\d+\s*集/.test(episode_label) ? "ongoing" : "unknown";
      const raw = Number(item?.first_visible_time);
      const timestamp = raw < 1e12 ? raw * 1e3 : raw;
      const published_at = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() ? timestamp : null;
      return { episode_label, completion_status, published_at };
    }
    function readRouterData(html) {
      const match = String(html).match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
      if (!match) throw new Error("\u6765\u6E90\u9875\u9762\u672A\u8FD4\u56DE\u76EE\u5F55\u6570\u636E\uFF0C\u8BF7\u91CD\u8BD5\u6216\u6253\u5F00\u6765\u6E90\u9875\u9762");
      const start = match.index + match[0].length - 1;
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
      }
      throw new Error("\u6765\u6E90\u76EE\u5F55\u6570\u636E\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u8BD5");
    }
    function parseCatalog(html, category, page, sourceUrl) {
      const router = readRouterData(html);
      const data = Object.values(router.loaderData || {}).find((value) => value?.categoryRoute?.contentType === category);
      if (!data || data.isSuccess === false || !Array.isArray(data.recommendList)) {
        throw new Error("\u6765\u6E90\u76EE\u5F55\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u8BD5\u6216\u6253\u5F00\u6765\u6E90\u9875\u9762");
      }
      const pageTitle = data.seo?.title || "";
      if (category === "comic") {
        return {
          success: true,
          results: [],
          page: 1,
          total: 0,
          totalPages: 0,
          genres: [],
          pageTitle,
          sourceUrl,
          unsupported: true,
          emptyMessage: "\u6F2B\u753B\u5C5E\u4E8E\u56FE\u6587\u9605\u8BFB\uFF0C\u6682\u4E0D\u652F\u6301\u89C6\u9891\u64AD\u653E\u6216\u4E0B\u8F7D\uFF1B\u8BF7\u5207\u6362\u300C\u6F2B\u5267\u300D\u6216\u6253\u5F00\u6765\u6E90\u9875\u9762\u9605\u8BFB\u3002"
        };
      }
      const seen = /* @__PURE__ */ new Set();
      const results = data.recommendList.filter((item) => {
        if (!/^\d{6,}$/.test(item?.series_id) || typeof item.series_name !== "string" || !item.series_name.trim() || seen.has(String(item.series_id))) return false;
        seen.add(String(item.series_id));
        return true;
      }).map((item) => ({
        series_id: String(item.series_id),
        series_title: item.series_name.trim(),
        cover: item.series_cover || "",
        episode_count: Number(item.episode_cnt) || 0,
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 4) : [],
        ...publicMetadata(item),
        url: `${SITE}/detail?series_id=${item.series_id}`
      }));
      const genres = (Array.isArray(data.selectorList) ? data.selectorList : []).flatMap((row) => Array.isArray(row?.items) ? row.items : []).filter((item) => /^[a-z0-9-]+$/.test(item?.selector_item_id) && typeof item.show_name === "string").map((item) => ({ slug: item.selector_item_id, label: item.show_name }));
      return {
        success: true,
        results,
        page: Number(data.pagination?.pageNum) || page,
        total: Number(data.pagination?.total) || 0,
        totalPages: Number(data.pagination?.totalPages) || 0,
        genres,
        pageTitle,
        sourceUrl
      };
    }
    function decodeHtml(value) {
      return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (entity, key) => {
        if (key[0] !== "#") return { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" }[key.toLowerCase()];
        const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return code > 0 && code <= 1114111 ? String.fromCodePoint(code) : entity;
      });
    }
    function parseRanking(html, category, page, sourceUrl) {
      const text = (value) => decodeHtml(String(value).replace(/<[^>]*>/g, " ")).trim();
      let data;
      for (const script of String(html).matchAll(/<script\b([^>]*)>/gi)) {
        if (!/data-fn-name=["']mergeLoaderData["']/.test(script[1])) continue;
        const encoded = script[1].match(/data-fn-args=(?:"([^"]*)"|'([^']*)')/);
        if (!encoded) continue;
        try {
          const args = JSON.parse(decodeHtml(encoded[1] ?? encoded[2]));
          if (args[0] !== `rank_${category}/page` || !Array.isArray(args[1])) continue;
          const content = args[1].find((item) => item.key === "content" && item.routerDataFnName === "p");
          if (content?.routerDataFnArgs?.[0]) data = JSON.parse(content.routerDataFnArgs[0]);
        } catch (_) {
        }
      }
      const seen = /* @__PURE__ */ new Set();
      const normalize = (item) => {
        const id = String(item.seriesId || "");
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const rank = Number(item.rank);
        if (!/^\d{6,}$/.test(id) || !title || !Number.isSafeInteger(rank) || rank < 1 || seen.has(id)) return null;
        seen.add(id);
        return {
          series_id: id,
          series_title: title,
          cover: typeof item.cover === "string" && /^https?:\/\//.test(item.cover) ? item.cover : "",
          episode_count: Array.isArray(item.episodeVids) ? item.episodeVids.length : 0,
          tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 4) : [],
          rank,
          heat: typeof item.heatText === "string" ? item.heatText.trim() : "",
          ...publicMetadata(item),
          url: `${SITE}/detail?series_id=${id}`
        };
      };
      let results = data?.isSuccess !== false && Array.isArray(data?.rankList) ? data.rankList.map(normalize).filter(Boolean) : [];
      if (!results.length) {
        for (const match of String(html).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
          const article = match[1];
          const heading = article.match(/<h2\b[^>]*\bid=["']rank-title-(\d+)["'][^>]*>([\s\S]*?)<\/h2>/i);
          if (!heading || !article.includes(`/detail?series_id=${heading[1]}`)) continue;
          const cover = article.match(/<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)')/i);
          const tags = article.match(/<p\b[^>]*class=["'][^"']*pc-categories-[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
          const item = normalize({
            seriesId: heading[1],
            title: text(heading[2]),
            rank: article.match(/<span\b[^>]*>\s*(\d+)\s*<\/span>/i)?.[1],
            heatText: text(article).match(/[\d.,]+\s*[万亿]?\s*热度/)?.[0] || "",
            cover: cover ? decodeHtml(cover[1] ?? cover[2]) : "",
            tags: tags ? Array.from(tags[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi), (tag) => text(tag[1])) : []
          });
          if (item) results.push(item);
        }
      }
      if (!results.length) throw new Error("\u6765\u6E90\u699C\u5355\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u8BD5\u6216\u6253\u5F00\u6765\u6E90\u9875\u9762");
      const nav = String(html).match(/<nav\b[^>]*aria-label=["']榜单分页["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] || "";
      const current = Number(data?.pagination?.pageNum) || Number(nav.match(/aria-current=["']page["'][^>]*>(\d+)/)?.[1]) || page;
      const pages = Array.from(nav.matchAll(/href=["']([^"']+)["']/g), (match) => {
        try {
          const url = new URL(decodeHtml(match[1]), SITE);
          return url.origin === SITE && url.pathname === `/rank/${category}` ? Number(url.searchParams.get("page")) || 1 : 0;
        } catch (_) {
          return 0;
        }
      });
      return {
        success: true,
        results,
        page: current,
        total: 0,
        totalPages: Number(data?.pagination?.totalPages) || Math.max(current, ...pages),
        genres: [],
        pageTitle: text(String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""),
        sourceUrl
      };
    }
    async function fetchCatalogPageWithNet(url, signal, proxyLogin) {
      return new Promise((resolve, reject) => {
        const request = net.request({ url, useSessionCookies: false, headers: { "Cache-Control": "no-cache" } });
        let settled = false;
        const finish = (error, html) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (error) {
            reject(error);
            request.abort();
          } else resolve(html);
        };
        const abort = () => finish(new Error("\u76EE\u5F55\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5"));
        signal.addEventListener("abort", abort, { once: true });
        request.on("error", finish);
        request.on("login", (auth, callback) => proxyLogin ? proxyLogin(auth, callback) : callback());
        request.on("response", (response) => {
          const status = response.statusCode;
          if (status < 200 || status >= 300) return finish(new Error(`\u76EE\u5F55\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${status}\uFF09`));
          if (Number(response.headers["content-length"]) > MAX_PAGE_BYTES) return finish(new Error("\u76EE\u5F55\u9875\u9762\u8FC7\u5927\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_PAGE_BYTES) return finish(new Error("\u76EE\u5F55\u9875\u9762\u8FC7\u5927\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
            chunks.push(chunk);
          });
          response.on("error", finish);
          response.on("aborted", () => finish(new Error("\u76EE\u5F55\u8FDE\u63A5\u88AB\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u8BD5\u6216\u5207\u6362\u6765\u6E90")));
          response.on("end", () => {
            if (!settled) finish(null, Buffer.concat(chunks, size).toString("utf8"));
          });
        });
        if (signal.aborted) abort();
        else request.end();
      });
    }
    async function fetchCatalogPageWithTrustedDns(url, signal) {
      const response = await axios2.get(url, {
        ...webMediaRequestOptions2(url, { trustedOfficialDns: true }),
        timeout: TIMEOUT_MS,
        signal,
        responseType: "text",
        maxContentLength: MAX_PAGE_BYTES
      });
      return response.data;
    }
    async function fetchCatalogPage(url, signal, proxyLogin, allowTrustedDns, parse) {
      if (!net?.request) {
        const html = allowTrustedDns ? await fetchCatalogPageWithTrustedDns(url, signal) : (await axios2.get(url, {
          timeout: TIMEOUT_MS,
          signal,
          responseType: "text",
          maxContentLength: MAX_PAGE_BYTES
        })).data;
        return parse(html);
      }
      if (!allowTrustedDns) return parse(await fetchCatalogPageWithNet(url, signal, proxyLogin));
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return await Promise.any([
          fetchCatalogPageWithNet(url, controller.signal, proxyLogin).then(parse),
          fetchCatalogPageWithTrustedDns(url, controller.signal).then(parse)
        ]);
      } catch (aggregate) {
        throw aggregate.errors?.find((error) => /HTTP \d+|超时/.test(error.message)) || aggregate.errors?.[0] || aggregate;
      } finally {
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    }
    async function browseList(options = {}, proxyLogin) {
      const { category = "real-drama", genre = "", page = 1, forceRefresh = false } = options || {};
      const ranking = RANKINGS.has(category);
      if (!CATEGORIES.has(category) && !ranking || genre && (!/^[a-z0-9-]+$/.test(genre) || ranking)) return { success: false, error: "\u65E0\u6548\u7684\u76EE\u5F55\u5206\u7C7B\u6216\u9898\u6750" };
      const pg = Math.max(1, Number.parseInt(page, 10) || 1);
      const url = `${SITE}/${ranking ? "rank" : "category"}/${category}${genre ? `/${genre}` : ""}${pg > 1 ? `?page=${pg}` : ""}`;
      if (!forceRefresh && cache.get(url)?.expires > Date.now()) return cache.get(url).data;
      if (pending.has(url)) return pending.get(url);
      const task = (async () => {
        const controller = new AbortController();
        let timer;
        try {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("\u76EE\u5F55\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5"));
            }, TIMEOUT_MS);
          });
          const data = await Promise.race([fetchCatalogPage(
            url,
            controller.signal,
            proxyLogin,
            options.allowTrustedDns === true,
            (html) => (ranking ? parseRanking : parseCatalog)(html, category, pg, url)
          ), timeout]);
          cache.set(url, { expires: Date.now() + CACHE_MS, data });
          if (cache.size > 32) cache.delete(cache.keys().next().value);
          return data;
        } catch (error) {
          const message = controller.signal.aborted || error.code === "ECONNABORTED" ? "\u76EE\u5F55\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : /ECONNRESET|ERR_CONNECTION_RESET/.test(`${error.code} ${error.message}`) ? "\u7EA2\u679C\u8FDE\u63A5\u88AB\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u8BD5\u6216\u5207\u6362\u6765\u6E90\uFF08ECONNRESET\uFF09" : error.message;
          return { success: false, error: message, sourceUrl: url };
        } finally {
          clearTimeout(timer);
          pending.delete(url);
        }
      })();
      pending.set(url, task);
      return task;
    }
    module2.exports = { browseList, readRouterData, publicMetadata };
  }
});

// src/native/reelshort.js
var require_reelshort = __commonJS({
  "src/native/reelshort.js"(exports2, module2) {
    var axios2 = require_axios();
    var { isPublicMediaUrl: isPublicMediaUrl2, webMediaRequestOptions: webMediaRequestOptions2 } = require_web_media_guard();
    var ORIGIN = "https://www.reelshort.com";
    var UA2 = "Mozilla/5.0";
    var ID = /^[a-zA-Z0-9_]{1,100}$/;
    var SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    function text(value) {
      return String(value || "").replace(/<[^>]*>/g, "").trim();
    }
    function slug(title) {
      return text(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/ +/g, "-");
    }
    function parseId(value, episode = false) {
      const parts = String(value || "").split(":");
      if (parts[0] !== "reelshort" || parts.length !== (episode ? 5 : 3) || !ID.test(parts[1]) || !SLUG.test(parts[2]) || parts[2].length > 200 || episode && (!/^[1-9]\d{0,3}$/.test(parts[3]) || !ID.test(parts[4]))) throw new Error("ReelShort \u5267\u96C6\u7F16\u53F7\u65E0\u6548");
      return { bookId: parts[1], slug: parts[2], number: Number(parts[3]), chapterId: parts[4], seriesId: parts.slice(0, 3).join(":") };
    }
    function resolveSeriesId2(value) {
      if (String(value).startsWith("reelshort:")) return parseId(value).seriesId;
      let url;
      try {
        url = new URL(value);
      } catch (_) {
        throw new Error("ReelShort \u5206\u4EAB\u94FE\u63A5\u65E0\u6548");
      }
      const match = url.pathname.match(/^\/movie\/([a-z0-9-]+)-([a-zA-Z0-9_]+)\/?$/);
      if (url.origin !== ORIGIN || url.username || url.password || !match) throw new Error("\u8BF7\u8F93\u5165 ReelShort \u5B98\u7F51\u5267\u96C6\u94FE\u63A5");
      return parseId(`reelshort:${match[2]}:${match[1]}`).seriesId;
    }
    async function request(route, params = {}, options = {}) {
      const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 1e4;
      if (remaining <= 0) throw new Error("ReelShort \u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5");
      const timeout = Math.min(1e4, remaining), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const url = ORIGIN + route;
        const response = await axios2.get(url, {
          ...webMediaRequestOptions2(url),
          maxRedirects: 0,
          params,
          headers: { "User-Agent": UA2, Referer: ORIGIN + "/", "Accept-Language": "en-US,en;q=0.9" },
          timeout,
          signal: controller.signal,
          responseType: "text",
          maxContentLength: 4 * 1024 * 1024
        });
        const json = String(response.data).match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
        let data;
        try {
          data = JSON.parse(json);
        } catch (_) {
          throw new Error("ReelShort \u5B98\u7F51\u6570\u636E\u683C\u5F0F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
        }
        if (!data?.props?.pageProps || typeof data.props.pageProps !== "object") throw new Error("ReelShort \u5B98\u7F51\u6570\u636E\u683C\u5F0F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
        return data.props.pageProps;
      } catch (error) {
        const status = error.response?.status;
        if (status === 403 || status === 451) throw new Error(`ReelShort \u5F53\u524D\u5730\u533A\u6216\u7F51\u7EDC\u6682\u4E0D\u53EF\u7528\uFF08HTTP ${status}\uFF09`);
        if (status === 429) throw new Error("ReelShort \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        if (error.message?.startsWith("ReelShort ")) throw error;
        throw new Error(controller.signal.aborted || ["ECONNABORTED", "ETIMEDOUT"].includes(error.code) ? "ReelShort \u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : "ReelShort \u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u7A0D\u540E\u91CD\u8BD5");
      } finally {
        clearTimeout(timer);
      }
    }
    function mediaUrl(value) {
      return typeof value === "string" && value.startsWith("https://") && isPublicMediaUrl2(value) ? value : "";
    }
    function locked(item) {
      return ["locked", "is_locked", "is_lock", "isCharge"].some((key) => [true, 1, "1"].includes(item?.[key]));
    }
    function normalizeBook(book) {
      const id = String(book?.book_id || book?._id || ""), title = text(book?.book_title), path2 = slug(title);
      if (!ID.test(id) || !title || !SLUG.test(path2) || path2.length > 200) return null;
      return {
        series_id: `reelshort:${id}:${path2}`,
        series_title: title,
        cover: mediaUrl(book.book_pic),
        episode_count: Number(book.chapter_count) || 0,
        intro: text(book.special_desc),
        source: "reelshort",
        url: `${ORIGIN}/movie/${path2}-${id}`
      };
    }
    function pageResult(books, page, genres = []) {
      const seen = /* @__PURE__ */ new Set();
      const results = books.slice(0, 500).map(normalizeBook).filter((item) => {
        if (!item || seen.has(item.series_id)) return false;
        seen.add(item.series_id);
        return true;
      });
      if (books.length && !results.length) throw new Error("ReelShort \u7247\u5355\u7F3A\u5C11\u53EF\u7528\u5267\u96C6\u7F16\u53F7\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
      return {
        success: true,
        results,
        page,
        total: results.length,
        totalPages: page === 1 ? 1 : 0,
        hasMore: false,
        nextPage: null,
        genres,
        pageTitle: "ReelShort\uFF08\u6D77\u5916\uFF09",
        sourceUrl: ORIGIN + "/"
      };
    }
    async function browseList({ genre = "", page = 1 } = {}) {
      try {
        if (!Number.isSafeInteger(page) || page < 1) throw new Error("ReelShort \u9875\u7801\u65E0\u6548");
        if (page > 1) return pageResult([], page);
        const options = { deadline: Date.now() + 1e4 };
        const data = await request("/", {}, options);
        const shelves = data.fallback?.["/api/ms/hall/webInfo"]?.bookShelfList;
        if (!Array.isArray(shelves) || shelves.length > 100) throw new Error("ReelShort \u5B98\u7F51\u7247\u5355\u683C\u5F0F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
        const genres = shelves.map((shelf, index) => ({ slug: `shelf-${index}`, label: text(shelf.bookshelf_name) })).filter((item) => item.label);
        const selected = genre ? genres.find((item) => item.slug === genre) : null;
        if (genre && !selected) throw new Error("ReelShort \u5206\u7C7B\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
        const entries = (selected ? [shelves[Number(selected.slug.slice(6))]] : shelves).flatMap((shelf) => Array.isArray(shelf.books) ? shelf.books : []);
        const books = [], seen = /* @__PURE__ */ new Set();
        for (const book of entries) {
          const title = text(book?.book_title), key = title.toLowerCase();
          if (!title || seen.has(key)) continue;
          seen.add(key);
          if (normalizeBook(book)) books.push(book);
          else {
            const found = await search(title, 1, options);
            const matches = found.results?.filter((item) => item.series_title.toLowerCase() === key) || [];
            if (!found.success || matches.length !== 1) throw new Error(found.error || "ReelShort \u7247\u5355\u7F3A\u5C11\u552F\u4E00\u5BF9\u5E94\u7684\u5267\u96C6\u7F16\u53F7\uFF0C\u8BF7\u6309\u5B8C\u6574\u5267\u540D\u641C\u7D22");
            books.push({ ...book, book_id: parseId(matches[0].series_id).bookId });
          }
          if (books.length >= 12) break;
        }
        return pageResult(books, page, genres);
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function search(keyword, page = 1, options = {}) {
      try {
        const keywords = text(keyword);
        if (!keywords || keywords.length > 200 || !Number.isSafeInteger(page) || page < 1) throw new Error("ReelShort \u641C\u7D22\u8BCD\u6216\u9875\u7801\u65E0\u6548");
        if (page > 1) return pageResult([], page);
        const data = await request("/search", { keywords }, options);
        if (!Array.isArray(data.books)) throw new Error("ReelShort \u5B98\u7F51\u641C\u7D22\u683C\u5F0F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
        return pageResult(data.books, page);
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function detail(seriesId) {
      const id = parseId(seriesId);
      const props = await request(`/movie/${id.slug}-${id.bookId}`), data = props.data;
      if (!data || !Array.isArray(data.online_base) || data.online_base.length > 1e4 || (data.book_id || data._id) && String(data.book_id || data._id) !== id.bookId) throw new Error("ReelShort \u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
      return { id, data };
    }
    async function fetchEpisodeList2(seriesId) {
      const { data } = await detail(seriesId);
      const series_title = text(data.book_title), cover = mediaUrl(data.book_pic), seen = /* @__PURE__ */ new Map();
      if (!series_title) throw new Error("ReelShort \u7F3A\u5C11\u5267\u96C6\u6807\u9898\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
      const episodes = data.online_base.filter((ep) => Number.isSafeInteger(Number(ep.serial_number)) && Number(ep.serial_number) > 0 && Number(ep.serial_number) <= 9999 && ID.test(String(ep.chapter_id || ""))).map((ep) => ({
        vid: `${seriesId}:${Number(ep.serial_number)}:${ep.chapter_id}`,
        vid_index: Number(ep.serial_number),
        title: text(ep.chapter_name) || `\u7B2C ${Number(ep.serial_number)} \u96C6`,
        series_id: seriesId,
        series_title,
        cover,
        locked: locked(ep),
        source: "reelshort"
      })).filter((ep) => {
        if (seen.has(ep.vid_index) && seen.get(ep.vid_index) !== ep.vid) throw new Error("ReelShort \u5206\u96C6\u7F16\u53F7\u51B2\u7A81\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
        if (seen.has(ep.vid_index)) return false;
        seen.set(ep.vid_index, ep.vid);
        return true;
      }).sort((a, b) => a.vid_index - b.vid_index);
      if (!episodes.length) throw new Error("ReelShort \u5206\u96C6\u5217\u8868\u4E3A\u7A7A");
      return { series_id: seriesId, series_title, cover, intro: text(data.special_desc), total: episodes.length, episodes, source: "reelshort" };
    }
    async function fetchPlayUrlSingle2(vid, seriesId) {
      try {
        const id = parseId(vid, true);
        if (seriesId != null && seriesId !== "" && seriesId !== id.seriesId) throw new Error("ReelShort \u5206\u96C6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5267\u96C6");
        const list = await fetchEpisodeList2(id.seriesId), episode = list.episodes.find((ep) => ep.vid === vid);
        if (!episode) throw new Error("ReelShort \u672A\u627E\u5230\u8BE5\u5206\u96C6");
        if (episode.locked) return { url: null, source: "reelshort", locked: true, error: "\u8BE5\u96C6\u5DF2\u9501\u5B9A\uFF0C\u8BF7\u5728 ReelShort \u5B98\u65B9\u5E73\u53F0\u786E\u8BA4\u89C2\u770B\u6743\u9650" };
        const props = await request(`/episodes/episode-${id.number}-${id.slug}-${id.bookId}-${id.chapterId}`, { play_time: 1 });
        const data = props.data;
        if (!data || Number(data.serial_number) !== id.number || data.chapter_id && String(data.chapter_id) !== id.chapterId) throw new Error("ReelShort \u8FD4\u56DE\u7684\u5206\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
        if (locked(data) || !data.video_url) return { url: null, source: "reelshort", locked: true, error: "\u8BE5\u96C6\u672A\u63D0\u4F9B\u516C\u5F00\u64AD\u653E\u5730\u5740\uFF0C\u8BF7\u5728 ReelShort \u5B98\u65B9\u5E73\u53F0\u786E\u8BA4\u89C2\u770B\u6743\u9650" };
        const url = mediaUrl(data.video_url), extension = url && new URL(url).pathname.match(/\.(mp4|m3u8)$/i)?.[1].toLowerCase();
        if (!extension) throw new Error("ReelShort \u672A\u63D0\u4F9B\u53EF\u76F4\u63A5\u64AD\u653E\u7684 HTTPS MP4 \u6216 M3U8 \u5730\u5740");
        return {
          url,
          format: extension === "m3u8" ? "hls" : "mp4",
          source: "reelshort",
          spadeA: null,
          codec: "",
          vid,
          userAgent: UA2,
          referer: ORIGIN + "/"
        };
      } catch (error) {
        return { url: null, source: "reelshort", spadeA: null, codec: null, error: error.message };
      }
    }
    module2.exports = { resolveSeriesId: resolveSeriesId2, browseList, search, fetchEpisodeList: fetchEpisodeList2, fetchPlayUrlSingle: fetchPlayUrlSingle2 };
  }
});

// src/native/dramabox.js
var require_dramabox = __commonJS({
  "src/native/dramabox.js"(exports2, module2) {
    var axios2 = require_axios();
    var { isPublicMediaUrl: isPublicMediaUrl2 } = require_web_media_guard();
    var ORIGIN = "https://www.dramabox.com";
    var UA2 = "Mozilla/5.0";
    var ID = /^\d{1,24}$/;
    var text = (value) => String(value || "").replace(/<[^>]*>/g, "").trim();
    function parseId(value, episode = false) {
      const parts = String(value || "").split(":");
      if (parts[0] !== "dramabox" || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every((part) => ID.test(part))) throw new Error("DramaBox \u5267\u96C6\u7F16\u53F7\u65E0\u6548");
      return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(":") };
    }
    function resolveSeriesId2(value) {
      if (String(value).startsWith("dramabox:")) return parseId(value).seriesId;
      let url;
      try {
        url = new URL(value);
      } catch (_) {
        throw new Error("DramaBox \u5206\u4EAB\u94FE\u63A5\u65E0\u6548");
      }
      const id = url.pathname.match(/^\/(?:drama|movie)\/(\d{1,24})(?:\/|$)/)?.[1];
      if (url.protocol !== "https:" || !["www.dramabox.com", "www.dramaboxdb.com"].includes(url.hostname) || url.port || url.username || url.password || !id) throw new Error("\u8BF7\u8F93\u5165 DramaBox \u82F1\u6587\u5B98\u7F51\u5267\u96C6\u94FE\u63A5");
      return `dramabox:${id}`;
    }
    async function request(route, params = {}, options = {}) {
      const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 1e4;
      if (remaining <= 0) throw new Error("DramaBox \u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5");
      const timeout = Math.min(1e4, remaining), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await axios2.get(ORIGIN + route, {
          params,
          timeout,
          signal: controller.signal,
          maxRedirects: 0,
          maxContentLength: 8 * 1024 * 1024,
          responseType: "text",
          headers: { "User-Agent": UA2, Referer: ORIGIN + "/", "Accept-Language": "en-US,en;q=0.9" }
        });
        const raw = String(response.data).match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
        let data;
        try {
          data = JSON.parse(raw);
        } catch (_) {
          throw new Error("DramaBox \u5B98\u7F51\u6570\u636E\u683C\u5F0F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u7B49\u5F85\u9002\u914D");
        }
        const props = data?.props?.pageProps;
        if (!props || typeof props !== "object" || (props.locale ?? data.locale) !== "en") throw new Error("DramaBox \u5B98\u7F51\u6570\u636E\u6216\u8BED\u8A00\u4E0D\u5339\u914D");
        return props;
      } catch (error) {
        const status = error.response?.status;
        if ([403, 451].includes(status)) throw new Error(`DramaBox \u5F53\u524D\u7F51\u7EDC\u6216\u5730\u533A\u53D7\u9650\uFF08HTTP ${status}\uFF09\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u5206\u6D41`);
        if (status === 429) throw new Error("DramaBox \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        if (error.message?.startsWith("DramaBox ")) throw error;
        throw new Error(controller.signal.aborted || ["ECONNABORTED", "ETIMEDOUT"].includes(error.code) ? "DramaBox \u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : "DramaBox \u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u5206\u6D41\u6216\u7A0D\u540E\u91CD\u8BD5");
      } finally {
        clearTimeout(timer);
      }
    }
    function normalizeBook(book) {
      if (!book || !ID.test(String(book.bookId)) || !text(book.bookName || book.name)) return null;
      return {
        series_id: `dramabox:${book.bookId}`,
        series_title: text(book.bookName || book.name),
        cover: isPublicMediaUrl2(book.cover || book.coverWap) ? book.cover || book.coverWap : "",
        episode_count: Number(book.chapterCount ?? book.totalChapterNum) || 0,
        intro: text(book.introduction),
        source: "dramabox",
        url: `${ORIGIN}/drama/${book.bookId}`
      };
    }
    function pageResult(props, page, pagesKey) {
      const pages = Number(props[pagesKey]);
      if (!Array.isArray(props.bookList) || props.bookList.length > 500 || Number(props.pageNo) !== page || !Number.isSafeInteger(pages) || pages < 0) throw new Error("DramaBox \u5B98\u7F51\u5206\u9875\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
      const seen = /* @__PURE__ */ new Set(), results = props.bookList.map(normalizeBook).filter((item) => {
        if (!item || seen.has(item.series_id)) return false;
        seen.add(item.series_id);
        return true;
      });
      if (props.bookList.length && !results.length) throw new Error("DramaBox \u672A\u8FD4\u56DE\u6709\u6548\u5267\u96C6");
      const hasMore = results.length > 0 && page < pages;
      return {
        success: true,
        results,
        page,
        total: Number(props.totalNum) || 0,
        totalPages: pages,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        genres: [],
        pageTitle: "DramaBox\uFF08\u6D77\u5916\uFF09",
        sourceUrl: ORIGIN + "/browse"
      };
    }
    async function browseList({ page = 1, genre = "" } = {}) {
      try {
        if (!Number.isSafeInteger(page) || page < 1 || page > 1e4 || genre) throw new Error("DramaBox \u9875\u7801\u6216\u5206\u7C7B\u65E0\u6548");
        return pageResult(await request(page === 1 ? "/browse" : `/browse/0/${page}`), page, "pages");
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function search(keyword, page = 1, options = {}) {
      try {
        const searchValue = String(keyword || "").trim();
        if (!searchValue || searchValue.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 50) throw new Error("DramaBox \u641C\u7D22\u8BCD\u6216\u9875\u7801\u65E0\u6548");
        return pageResult(await request("/search", { searchValue, page }, options), page, "totalPage");
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function detail(seriesId, options = {}) {
      const id = parseId(seriesId), props = await request(`/drama/${id.bookId}`, {}, options);
      const book = normalizeBook(props.bookInfo), chapters = props.chapterList;
      if (book?.series_id !== seriesId || !Array.isArray(chapters) || !chapters.length || chapters.length > 1e4 || !Number.isSafeInteger(book.episode_count) || book.episode_count !== chapters.length) throw new Error("DramaBox \u8FD4\u56DE\u7684\u5267\u96C6\u6216\u5B8C\u6574\u5206\u96C6\u6570\u91CF\u4E0D\u4E00\u81F4");
      const ids = /* @__PURE__ */ new Set(), sorted = [...chapters].sort((a, b) => Number(a.index) - Number(b.index));
      for (const [index, chapter] of sorted.entries()) {
        const cid = String(chapter?.id || "");
        if (!ID.test(cid) || ids.has(cid) || !Number.isSafeInteger(chapter.index) || chapter.index !== index) throw new Error("DramaBox \u5206\u96C6\u7F16\u53F7\u91CD\u590D\u6216\u4E0D\u8FDE\u7EED");
        ids.add(cid);
      }
      return { book, chapters: sorted };
    }
    async function fetchEpisodeList2(seriesId, options = {}) {
      const { book, chapters } = await detail(seriesId, options);
      return { ...book, total: chapters.length, episodes: chapters.map((chapter) => ({
        vid: `${seriesId}:${chapter.id}`,
        vid_index: chapter.index + 1,
        title: text(chapter.name) || `\u7B2C ${chapter.index + 1} \u96C6`,
        series_id: seriesId,
        series_title: book.series_title,
        cover: book.cover,
        duration: Number(chapter.duration) / 1e3 || 0,
        locked: chapter.unlock !== true,
        source: "dramabox"
      })) };
    }
    function assertMediaUrl(value) {
      let url;
      try {
        url = new URL(value);
      } catch (_) {
        throw new Error("DramaBox \u7247\u6E90\u5730\u5740\u65E0\u6548");
      }
      if (url.protocol !== "https:" || url.port || url.username || url.password || !isPublicMediaUrl2(value) || !(url.hostname === "dramaboxdb.com" || url.hostname.endsWith(".dramaboxdb.com"))) throw new Error("DramaBox \u7247\u6E90\u5FC5\u987B\u6765\u81EA\u5B98\u65B9 HTTPS CDN");
      return url;
    }
    function mediaRequestOptions(value) {
      assertMediaUrl(value);
      return { maxRedirects: 3, beforeRedirect(_options, response, request2) {
        assertMediaUrl(new URL(response.headers.location, request2.url).href);
      } };
    }
    async function fetchPlayUrlSingle2(vid, seriesId, options = {}) {
      try {
        const id = parseId(vid, true);
        if (seriesId != null && seriesId !== "" && seriesId !== id.seriesId) throw new Error("DramaBox \u5206\u96C6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5267\u96C6");
        const { chapters } = await detail(id.seriesId, options), chapter = chapters.find((item) => String(item.id) === id.chapterId);
        if (!chapter) throw new Error("DramaBox \u672A\u627E\u5230\u8BE5\u5206\u96C6");
        if (chapter.unlock !== true) return { url: null, source: "dramabox", locked: true, error: "\u8BE5\u96C6\u672A\u516C\u5F00\u89E3\u9501\uFF0C\u8BF7\u5728 DramaBox \u5B98\u65B9\u5E73\u53F0\u786E\u8BA4\u89C2\u770B\u6743\u9650" };
        const url = assertMediaUrl(chapter.mp4);
        if (chapter.m3u8Flag || !/\.mp4$/i.test(url.pathname) || /encrypt/i.test(url.pathname)) throw new Error("DramaBox \u5F53\u524D\u4EC5\u652F\u6301\u5B98\u65B9\u516C\u5F00\u672A\u52A0\u5BC6 MP4");
        return {
          url: url.href,
          source: "dramabox",
          format: "mp4",
          spadeA: null,
          codec: "",
          vid,
          duration: Number(chapter.duration) / 1e3 || 0,
          userAgent: UA2,
          referer: ORIGIN + "/"
        };
      } catch (error) {
        return { url: null, source: "dramabox", spadeA: null, codec: null, error: error.message };
      }
    }
    module2.exports = { resolveSeriesId: resolveSeriesId2, browseList, search, fetchEpisodeList: fetchEpisodeList2, fetchPlayUrlSingle: fetchPlayUrlSingle2, mediaRequestOptions };
  }
});

// src/store.js
var require_store = __commonJS({
  "src/store.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var dataFile = null;
    var cache = null;
    var durable = "{}";
    var errorHandler = null;
    var readError = null;
    var writeError = false;
    var safeStorage = null;
    var runtimeProxyPassword = "";
    var proxyPasswordWarning = "";
    var PROXY_PASSWORD_CIPHER = "proxy_password_ciphertext";
    var SECURE_STORAGE_UNAVAILABLE = "\u7CFB\u7EDF\u5B89\u5168\u5B58\u50A8\u4E0D\u53EF\u7528\uFF1B\u4EE3\u7406\u5BC6\u7801\u4EC5\u5728\u672C\u6B21\u8FD0\u884C\u671F\u95F4\u4FDD\u7559\uFF0C\u91CD\u542F\u540E\u9700\u8981\u91CD\u65B0\u8F93\u5165\u3002";
    var PROXY_PASSWORD_DECRYPT_FAILED = "\u5DF2\u4FDD\u5B58\u7684\u4EE3\u7406\u5BC6\u7801\u65E0\u6CD5\u89E3\u5BC6\uFF1B\u539F\u5BC6\u6587\u5DF2\u4FDD\u7559\uFF0C\u53EF\u91CD\u65B0\u8F93\u5165\u5BC6\u7801\u6216\u6E05\u9664\u3002";
    var READ_ERROR_MESSAGE = "\u8BFB\u53D6\u672C\u5730\u6570\u636E\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u539F\u6587\u4EF6\u5E76\u6682\u505C\u4FDD\u5B58\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6216\u76EE\u5F55\u6743\u9650\uFF0C\u6062\u590D\u6570\u636E\u540E\u91CD\u542F\u5E94\u7528\u3002";
    function reportReadError() {
      try {
        errorHandler?.({ error: READ_ERROR_MESSAGE });
      } catch {
      }
    }
    function encryptionAvailable() {
      try {
        return safeStorage?.isEncryptionAvailable?.() === true && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
      } catch {
        return false;
      }
    }
    function encryptProxyPassword(password) {
      if (!encryptionAvailable()) return null;
      try {
        const encrypted = safeStorage.encryptString(password);
        if (!encrypted?.length) return null;
        return Buffer.from(encrypted).toString("base64");
      } catch {
        return null;
      }
    }
    function decodeUrlPart(value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    function extractEmbeddedProxyPassword(settings) {
      const original = String(settings.proxy_host || "").trim();
      if (!original.includes("@")) return "";
      let username = "";
      let password = "";
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(original) ? original : `http://${original}`);
        username = decodeUrlPart(url.username);
        password = decodeUrlPart(url.password);
      } catch {
        const at = original.lastIndexOf("@");
        const userInfo = original.slice(0, at).split("://").pop();
        const separator = userInfo.indexOf(":");
        username = decodeUrlPart(separator < 0 ? userInfo : userInfo.slice(0, separator));
        password = separator < 0 ? "" : decodeUrlPart(userInfo.slice(separator + 1));
      }
      settings.proxy_host = original.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, "$1");
      if (username) settings.proxy_username = username;
      return password;
    }
    function stripPublicSecretFields(settings) {
      delete settings.proxy_password;
      delete settings.proxy_password_set;
      delete settings.proxy_password_warning;
      delete settings.clear_proxy_password;
    }
    function hydrateProxyPassword(settings) {
      let changed = false;
      const embeddedPassword = extractEmbeddedProxyPassword(settings);
      if (Object.prototype.hasOwnProperty.call(settings, "proxy_password")) changed = true;
      const plaintext = typeof settings.proxy_password === "string" ? settings.proxy_password : "";
      const storedCipher = typeof settings[PROXY_PASSWORD_CIPHER] === "string" ? settings[PROXY_PASSWORD_CIPHER] : "";
      stripPublicSecretFields(settings);
      delete settings[PROXY_PASSWORD_CIPHER];
      runtimeProxyPassword = "";
      proxyPasswordWarning = "";
      const password = plaintext || embeddedPassword;
      if (password) {
        runtimeProxyPassword = password;
        const encrypted = encryptProxyPassword(password);
        if (encrypted) settings[PROXY_PASSWORD_CIPHER] = encrypted;
        else proxyPasswordWarning = SECURE_STORAGE_UNAVAILABLE;
        return true;
      }
      if (!storedCipher) return changed;
      settings[PROXY_PASSWORD_CIPHER] = storedCipher;
      if (!encryptionAvailable()) {
        proxyPasswordWarning = SECURE_STORAGE_UNAVAILABLE;
        return changed;
      }
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(storedCipher, "base64"));
        if (typeof decrypted !== "string") throw new TypeError("Invalid decrypted proxy password");
        runtimeProxyPassword = decrypted;
      } catch {
        proxyPasswordWarning = PROXY_PASSWORD_DECRYPT_FAILED;
      }
      return changed;
    }
    function serializableCache() {
      const copy = structuredClone(cache || {});
      if (copy.settings) {
        stripPublicSecretFields(copy.settings);
        if (!copy.settings[PROXY_PASSWORD_CIPHER]) delete copy.settings[PROXY_PASSWORD_CIPHER];
      }
      return copy;
    }
    function loadCache() {
      if (!dataFile) throw new Error("store \u672A\u521D\u59CB\u5316");
      if (cache) return cache;
      let secretsChanged = false;
      try {
        cache = JSON.parse(fs2.readFileSync(dataFile, "utf8"));
        if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
          throw new TypeError("Invalid store document");
        }
        for (const key of ["tasks", "series", "mergeTasks"]) {
          if (key in cache && !Array.isArray(cache[key])) throw new TypeError(`Invalid store ${key}`);
        }
        for (const key of ["settings", "playback"]) {
          if (key in cache && (!cache[key] || typeof cache[key] !== "object" || Array.isArray(cache[key]))) {
            throw new TypeError(`Invalid store ${key}`);
          }
        }
      } catch (e) {
        cache = {};
        if (e.code !== "ENOENT") {
          readError = new Error(READ_ERROR_MESSAGE, { cause: e });
          readError.code = "STORE_READ_FAILED";
          reportReadError();
        }
      }
      if (!Array.isArray(cache.tasks)) cache.tasks = [];
      if (!cache.settings || typeof cache.settings !== "object") cache.settings = {};
      secretsChanged = hydrateProxyPassword(cache.settings);
      durable = JSON.stringify(serializableCache());
      if (secretsChanged && !readError) flush();
      return cache;
    }
    function flush() {
      if (!dataFile) return;
      if (readError) {
        cache = JSON.parse(durable);
        reportReadError();
        throw readError;
      }
      const temporary = dataFile + ".tmp";
      try {
        fs2.mkdirSync(path2.dirname(dataFile), { recursive: true });
        const serialized = JSON.stringify(serializableCache(), null, 2);
        const fd = fs2.openSync(temporary, "w", 384);
        try {
          fs2.writeFileSync(fd, serialized, "utf8");
          fs2.fsyncSync(fd);
        } finally {
          fs2.closeSync(fd);
        }
        fs2.renameSync(temporary, dataFile);
        durable = serialized;
        if (writeError) {
          writeError = false;
          try {
            errorHandler?.(null);
          } catch {
          }
        }
      } catch (e) {
        try {
          fs2.unlinkSync(temporary);
        } catch {
        }
        cache = JSON.parse(durable);
        writeError = true;
        try {
          errorHandler?.({ error: "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u78C1\u76D8\u7A7A\u95F4\u6216\u76EE\u5F55\u6743\u9650\uFF1B\u672C\u6B21\u53D8\u66F4\u672A\u80FD\u4FDD\u5B58\u3002" });
        } catch {
        }
        throw e;
      }
    }
    function init(filePath, { safeStorage: injectedSafeStorage } = {}) {
      dataFile = filePath;
      safeStorage = injectedSafeStorage || null;
      cache = null;
      readError = null;
      writeError = false;
      runtimeProxyPassword = "";
      proxyPasswordWarning = "";
      loadCache();
    }
    function getSettings() {
      const settings = { ...loadCache().settings };
      const hasStoredPassword = Object.prototype.hasOwnProperty.call(settings, PROXY_PASSWORD_CIPHER);
      delete settings[PROXY_PASSWORD_CIPHER];
      if (runtimeProxyPassword || hasStoredPassword || proxyPasswordWarning) {
        settings.proxy_password = runtimeProxyPassword;
        settings.proxy_password_set = !!runtimeProxyPassword || hasStoredPassword;
        settings.proxy_password_warning = proxyPasswordWarning;
      }
      return settings;
    }
    function saveSettings(settings, { clearProxyPassword = false } = {}) {
      const current = loadCache();
      const previousCache = structuredClone(current);
      const previousPassword = runtimeProxyPassword;
      const previousWarning = proxyPasswordWarning;
      const incoming = settings && typeof settings === "object" ? structuredClone(settings) : {};
      const shouldClear = clearProxyPassword === true || incoming.clear_proxy_password === true;
      const embeddedPassword = extractEmbeddedProxyPassword(incoming);
      const requestedPassword = typeof incoming.proxy_password === "string" ? incoming.proxy_password : "";
      const currentCipher = typeof current.settings[PROXY_PASSWORD_CIPHER] === "string" ? current.settings[PROXY_PASSWORD_CIPHER] : "";
      stripPublicSecretFields(incoming);
      delete incoming[PROXY_PASSWORD_CIPHER];
      let nextPassword = runtimeProxyPassword;
      let nextCipher = currentCipher;
      let nextWarning = proxyPasswordWarning;
      if (shouldClear) {
        nextPassword = "";
        nextCipher = "";
        nextWarning = "";
      } else if (requestedPassword || embeddedPassword) {
        const password = requestedPassword || embeddedPassword;
        if (password === nextPassword && nextCipher) {
          nextWarning = proxyPasswordWarning;
        } else {
          nextPassword = password;
          nextCipher = encryptProxyPassword(password) || "";
          nextWarning = nextCipher ? "" : SECURE_STORAGE_UNAVAILABLE;
        }
      } else if (nextPassword && !nextCipher) {
        nextCipher = encryptProxyPassword(nextPassword) || "";
        if (nextCipher) nextWarning = "";
      }
      if (nextCipher) incoming[PROXY_PASSWORD_CIPHER] = nextCipher;
      current.settings = incoming;
      runtimeProxyPassword = nextPassword;
      proxyPasswordWarning = nextWarning;
      try {
        flush();
      } catch (error) {
        cache = previousCache;
        runtimeProxyPassword = previousPassword;
        proxyPasswordWarning = previousWarning;
        throw error;
      }
    }
    function getAnnouncementState() {
      const state = loadCache().announcement;
      return state && typeof state === "object" && !Array.isArray(state) ? structuredClone(state) : {};
    }
    function saveAnnouncementState(patch) {
      loadCache().announcement = { ...getAnnouncementState(), ...patch };
      flush();
    }
    function getTasks() {
      return loadCache().tasks;
    }
    function saveTasks(tasks) {
      loadCache().tasks = tasks || [];
      flush();
    }
    function getSeries() {
      const c = loadCache();
      if (!Array.isArray(c.series)) c.series = [];
      return c.series;
    }
    function saveSeries(list) {
      loadCache().series = list || [];
      flush();
    }
    function getPlayback() {
      const c = loadCache();
      if (!c.playback || typeof c.playback !== "object") c.playback = {};
      return c.playback;
    }
    function savePlayback(map) {
      loadCache().playback = map || {};
      flush();
    }
    function getMergeTasks() {
      const c = loadCache();
      if (!Array.isArray(c.mergeTasks)) c.mergeTasks = [];
      return c.mergeTasks;
    }
    function saveMergeTasks(list) {
      loadCache().mergeTasks = list || [];
      flush();
    }
    module2.exports = {
      setErrorHandler: (handler) => {
        errorHandler = handler;
      },
      init,
      getSettings,
      saveSettings,
      getAnnouncementState,
      saveAnnouncementState,
      getTasks,
      saveTasks,
      getSeries,
      saveSeries,
      getPlayback,
      savePlayback,
      getMergeTasks,
      saveMergeTasks
    };
  }
});

// src/native/custom-source.js
var require_custom_source = __commonJS({
  "src/native/custom-source.js"(exports2, module2) {
    var axios2 = require_axios();
    var store = require_store();
    var { isPublicMediaUrl: isPublicMediaUrl2, webMediaRequestOptions: webMediaRequestOptions2 } = require_web_media_guard();
    var UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
    var ID = /^\d{1,30}$/;
    var USER_AGENT = "Mozilla/5.0";
    var activeRequests = /* @__PURE__ */ new Map();
    var plainText = (value) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim() : "";
    function validateSource(draft) {
      if (!draft || typeof draft !== "object") throw new Error("\u81EA\u5B9A\u4E49\u6E90\u914D\u7F6E\u65E0\u6548");
      const name = plainText(draft.name);
      if (!name || name.length > 80) throw new Error("\u6765\u6E90\u540D\u79F0\u9700\u4E3A 1 \u81F3 80 \u4E2A\u5B57\u7B26");
      if (draft.id != null && !UUID.test(String(draft.id))) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u7F16\u53F7\u65E0\u6548");
      if (typeof draft.url !== "string" || draft.url.length > 4096 || !isPublicMediaUrl2(draft.url)) {
        throw new Error("\u63A5\u53E3\u9700\u4E3A\u4E0D\u542B\u8D26\u53F7\u5BC6\u7801\u7684\u516C\u7F51 HTTP \u6216 HTTPS \u5730\u5740");
      }
      const url = new URL(draft.url);
      if (url.pathname === "/") url.pathname = "/api.php/provide/vod/";
      url.hash = "";
      return {
        ...draft.id == null ? {} : { id: String(draft.id).toLowerCase() },
        name,
        url: url.href,
        enabled: draft.enabled !== false
      };
    }
    function sourceId(value) {
      const parts = String(value || "").split(":");
      const id = parts[0] === "custom" ? parts[1] : parts[0];
      if (!UUID.test(id || "")) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u7F16\u53F7\u65E0\u6548");
      return id.toLowerCase();
    }
    function assertEnabled(value) {
      const id = sourceId(value);
      const sources = store.getSettings().custom_sources;
      const source = Array.isArray(sources) && sources.find((item) => String(item?.id).toLowerCase() === id);
      if (!source || source.enabled !== true) throw new Error("\u8BE5\u81EA\u5B9A\u4E49\u6E90\u5DF2\u7981\u7528\u6216\u5220\u9664");
      return validateSource(source);
    }
    function parseId(value, episode = false) {
      const parts = String(value || "").split(":");
      if (parts[0] !== "custom" || parts.length !== (episode ? 5 : 3) || !UUID.test(parts[1]) || !ID.test(parts[2]) || episode && !parts.slice(3).every((part) => /^\d{1,5}$/.test(part))) throw new Error("\u81EA\u5B9A\u4E49\u5267\u96C6\u7F16\u53F7\u65E0\u6548");
      return {
        id: parts[1].toLowerCase(),
        vodId: parts[2],
        seriesId: `custom:${parts[1].toLowerCase()}:${parts[2]}`,
        line: Number(parts[3]),
        episode: Number(parts[4])
      };
    }
    function cancelRequests(value) {
      const requests = activeRequests.get(sourceId(value));
      if (requests) for (const controller of requests) controller.abort();
    }
    async function request(source, params, draft = false) {
      const check = () => {
        if (!draft && assertEnabled(source.id).url !== source.url) throw new Error("\u6765\u6E90\u914D\u7F6E\u5DF2\u53D8\u66F4\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D");
      };
      check();
      const url = new URL(source.url);
      for (const key of ["ac", "pg", "t", "wd", "ids", "at"]) url.searchParams.delete(key);
      for (const [key, value] of Object.entries({ ac: "detail", at: "json", ...params })) url.searchParams.set(key, String(value));
      const guard = webMediaRequestOptions2(url.href);
      const controller = new AbortController();
      const requests = activeRequests.get(source.id) || /* @__PURE__ */ new Set();
      activeRequests.set(source.id, requests);
      requests.add(controller);
      const timer = setTimeout(() => controller.abort(), 12e3);
      try {
        const response = await axios2.get(url.href, {
          // Proxy selection follows app settings; the selected proxy owns final destination DNS.
          ...guard,
          adapter: "http",
          timeout: 12e3,
          signal: controller.signal,
          maxContentLength: 8 * 1024 * 1024,
          maxBodyLength: 1024,
          responseType: "text",
          transformResponse: [(data2) => data2],
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          lookup(hostname, options, callback) {
            try {
              check();
            } catch (error) {
              callback(error);
              return;
            }
            guard.lookup(hostname, options, (error, ...result) => {
              if (error) {
                callback(error);
                return;
              }
              try {
                check();
              } catch (failure) {
                callback(failure);
                return;
              }
              callback(null, ...result);
            });
          },
          beforeRedirect(options, response2, request2) {
            check();
            guard.beforeRedirect(options, response2, request2);
          }
        });
        check();
        let data;
        try {
          data = JSON.parse(response.data);
        } catch (_) {
          throw new Error("\u81EA\u5B9A\u4E49\u6E90\u672A\u8FD4\u56DE\u6709\u6548 JSON");
        }
        if (!data || Number(data.code) !== 1 || !Array.isArray(data.list) || data.list.length > 500) {
          throw new Error("\u81EA\u5B9A\u4E49\u6E90\u8FD4\u56DE\u7684\u82F9\u679C CMS \u6570\u636E\u65E0\u6548");
        }
        return data;
      } catch (error) {
        if (/^(自定义源|该自定义源|来源配置)/.test(error.message)) throw error;
        throw new Error(controller.signal.aborted || ["ECONNABORTED", "ETIMEDOUT"].includes(error.code) ? "\u81EA\u5B9A\u4E49\u6E90\u8BF7\u6C42\u5DF2\u53D6\u6D88\u6216\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : "\u81EA\u5B9A\u4E49\u6E90\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u516C\u7F51\u63A5\u53E3\u4E0E\u7F51\u7EDC");
      } finally {
        clearTimeout(timer);
        requests.delete(controller);
        if (!requests.size && activeRequests.get(source.id) === requests) activeRequests.delete(source.id);
      }
    }
    function isLocked(item) {
      return item.locked === true || Number(item.vod_points_play) > 0 || Number(item.vod_points) > 0 || !!String(item.vod_pwd_play || item.vod_pwd || "").trim();
    }
    function normalizeItem(item, source) {
      if (!item || !ID.test(String(item.vod_id)) || !plainText(item.vod_name)) return null;
      return {
        series_id: `custom:${source.id}:${item.vod_id}`,
        series_title: plainText(item.vod_name),
        cover: isPublicMediaUrl2(item.vod_pic) ? item.vod_pic : "",
        episode_count: Number(item.vod_total) || 0,
        intro: plainText(item.vod_content),
        tags: plainText(item.type_name) ? [plainText(item.type_name)] : [],
        source: `custom:${source.id}`,
        locked: isLocked(item)
      };
    }
    function pageResult(data, source, page) {
      if (data.page != null && Number(data.page) !== page) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u8FD4\u56DE\u7684\u9875\u7801\u4E0D\u4E00\u81F4");
      const seen = /* @__PURE__ */ new Set();
      const results = data.list.map((item) => normalizeItem(item, source)).filter((item) => {
        if (!item || seen.has(item.series_id)) return false;
        seen.add(item.series_id);
        return true;
      });
      const totalPages = Math.max(0, Number.parseInt(data.pagecount, 10) || 0);
      const endpoint = new URL(source.url);
      return {
        success: true,
        results,
        page,
        total: Math.max(0, Number.parseInt(data.total, 10) || 0),
        totalPages,
        hasMore: results.length > 0 && page < totalPages,
        nextPage: results.length > 0 && page < totalPages ? page + 1 : null,
        genres: (Array.isArray(data.class) ? data.class : []).slice(0, 500).filter((item) => ID.test(String(item?.type_id)) && plainText(item.type_name)).map((item) => ({ slug: String(item.type_id), label: plainText(item.type_name) })),
        pageTitle: source.name,
        sourceUrl: endpoint.origin + endpoint.pathname
      };
    }
    async function fetchCatalog({ source, genre = "", page = 1 } = {}) {
      try {
        const config = assertEnabled(source), pg = Number(page);
        if (!Number.isSafeInteger(pg) || pg < 1 || pg > 1e5 || genre && !ID.test(String(genre))) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u5206\u7C7B\u6216\u9875\u7801\u65E0\u6548");
        const data = await request(config, { pg, ...genre ? { t: genre } : {} });
        return pageResult(data, config, pg);
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function searchSeries(keyword, { source, page = 1 } = {}) {
      try {
        const config = assertEnabled(source), pg = Number(page), wd = String(keyword || "").trim();
        if (!wd || wd.length > 200 || !Number.isSafeInteger(pg) || pg < 1 || pg > 1e5) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u641C\u7D22\u8BCD\u6216\u9875\u7801\u65E0\u6548");
        return pageResult(await request(config, { wd, pg }), config, pg);
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function detail(seriesId) {
      const id = parseId(seriesId), source = assertEnabled(id.id);
      const data = await request(source, { ids: id.vodId });
      if (data.list.length !== 1 || String(data.list[0]?.vod_id) !== id.vodId) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
      const item = data.list[0];
      if (!normalizeItem(item, source)) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u8BE6\u60C5\u65E0\u6548");
      return { id, source, item };
    }
    function episodeKey(title) {
      const number = title.match(/^(?:第\s*)?(\d+)\s*(?:集|话|期)?$/);
      return number ? `number:${Number(number[1])}` : title;
    }
    function mediaLines(item) {
      const names = String(item.vod_play_from || "").split("$$$");
      return String(item.vod_play_url || "").split("$$$").slice(0, 32).map((line, lineIndex) => ({
        line: lineIndex,
        name: plainText(names[lineIndex]),
        episodes: line.split("#").slice(0, 1e4).map((entry, episodeIndex) => {
          const split = entry.indexOf("$");
          if (split < 1) return null;
          const title = plainText(entry.slice(0, split)), value = entry.slice(split + 1).trim();
          if (!title || !isPublicMediaUrl2(value)) return null;
          const url = new URL(value), extension = url.pathname.match(/\.(mp4|m3u8)$/i)?.[1].toLowerCase();
          if (!extension) return null;
          return { title, key: episodeKey(title), url: url.href, format: extension === "m3u8" ? "hls" : "mp4", line: lineIndex, episode: episodeIndex };
        }).filter(Boolean)
      })).filter((line) => line.episodes.length);
    }
    async function fetchEpisodeList2(seriesId) {
      const { id, source, item } = await detail(seriesId);
      const lines = mediaLines(item).sort((a, b) => b.episodes.length - a.episodes.length);
      if (!lines.length) throw new Error("\u8BE5\u5267\u6CA1\u6709\u53EF\u76F4\u63A5\u64AD\u653E\u7684 MP4 \u6216 M3U8 \u5206\u96C6\uFF0C\u4E0D\u652F\u6301\u7F51\u9875\u89E3\u6790");
      const normalized = normalizeItem(item, source), seen = /* @__PURE__ */ new Set();
      const episodes = lines[0].episodes.filter((episode) => {
        if (seen.has(episode.key)) return false;
        seen.add(episode.key);
        return true;
      }).map((episode, index) => ({
        vid: `${id.seriesId}:${episode.line}:${episode.episode}`,
        vid_index: index + 1,
        title: episode.title,
        series_id: id.seriesId,
        series_title: normalized.series_title,
        cover: normalized.cover,
        locked: normalized.locked,
        source: normalized.source
      }));
      return { ...normalized, total: episodes.length, episodes };
    }
    async function fetchPlayUrlSingle2(vid, sid) {
      try {
        const id = parseId(vid, true);
        if (sid != null && sid !== "" && parseId(sid).seriesId !== id.seriesId) throw new Error("\u81EA\u5B9A\u4E49\u5206\u96C6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5267\u96C6");
        const { source, item } = await detail(id.seriesId);
        if (isLocked(item)) return { url: null, source: "custom", locked: true, error: "\u8BE5\u5267\u5F53\u524D\u9700\u4ED8\u8D39\u6216\u5BC6\u7801\uFF0C\u8BF7\u5728\u6765\u6E90\u5E73\u53F0\u786E\u8BA4\u89C2\u770B\u6743\u9650" };
        const lines = mediaLines(item);
        const selected = lines.find((line) => line.line === id.line)?.episodes.find((episode) => episode.episode === id.episode);
        if (!selected) throw new Error("\u81EA\u5B9A\u4E49\u6E90\u672A\u627E\u5230\u53EF\u76F4\u63A5\u64AD\u653E\u7684\u5206\u96C6");
        const candidates = [selected, ...lines.flatMap((line) => line.episodes.filter((episode) => episode.key === selected.key))].filter((episode, index, all) => all.findIndex((other) => other.url === episode.url) === index).map((episode) => ({
          url: episode.url,
          format: episode.format,
          source: "custom",
          spadeA: null,
          codec: "",
          vid: `${id.seriesId}:${episode.line}:${episode.episode}`,
          userAgent: USER_AGENT,
          referer: new URL(source.url).origin + "/"
        }));
        return { ...candidates[0], candidates };
      } catch (error) {
        return { url: null, source: "custom", spadeA: null, codec: null, error: error.message };
      }
    }
    async function testCustomSource(draft) {
      try {
        const source = validateSource(draft);
        const data = await request(source, { pg: 1 }, true);
        return { success: true, count: data.list.length, genres: pageResult(data, source, 1).genres };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    module2.exports = {
      validateSource,
      validateCustomSource: validateSource,
      testCustomSource,
      assertEnabled,
      cancelRequests,
      fetchCatalog,
      browseList: fetchCatalog,
      searchSeries,
      fetchEpisodeList: fetchEpisodeList2,
      fetchPlayUrlSingle: fetchPlayUrlSingle2
    };
  }
});

// src/native/hema.js
var require_hema = __commonJS({
  "src/native/hema.js"(exports2, module2) {
    var axios2 = require_axios();
    var { isPublicMediaUrl: isPublicMediaUrl2 } = require_web_media_guard();
    var ORIGIN = "https://www.kuaikaw.cn";
    var ID = /^\d{1,30}$/;
    var genreCache;
    function plainText(value) {
      return String(value || "").replace(/<[^>]*>/g, "").trim();
    }
    function httpsUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && isPublicMediaUrl2(url.href) ? url.href : "";
      } catch (_) {
        return "";
      }
    }
    function parseId(value, episode = false) {
      const parts = String(value || "").split(":");
      if (parts[0] !== "hema" || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every((part) => ID.test(part))) {
        throw new Error("\u6CB3\u9A6C\u5267\u96C6\u7F16\u53F7\u65E0\u6548");
      }
      return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(":") };
    }
    async function request(apiPath, body, options = {}) {
      const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 1e4;
      if (remaining <= 0) throw new Error("\u6CB3\u9A6C\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5");
      const timeout = Math.min(1e4, remaining);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const requestOptions = {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: body ? "application/json" : "text/html",
          "Content-Type": "application/json",
          pname: "www.kuaikaw.cn",
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`
        },
        timeout,
        signal: controller.signal,
        maxRedirects: 0,
        maxContentLength: 8 * 1024 * 1024,
        responseType: body ? "json" : "text"
      };
      try {
        const response = body ? await axios2.post(ORIGIN + apiPath, body, requestOptions) : await axios2.get(ORIGIN + apiPath, requestOptions);
        return response.data;
      } catch (error) {
        throw new Error(controller.signal.aborted || error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" ? "\u6CB3\u9A6C\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : "\u6CB3\u9A6C\u6765\u6E90\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      } finally {
        clearTimeout(timer);
      }
    }
    function normalizeBooks(books) {
      const seen = /* @__PURE__ */ new Set();
      const results = books.filter((item) => item && ID.test(String(item.bookId || "")) && plainText(item.bookName)).map((item) => ({
        series_id: `hema:${item.bookId}`,
        series_title: plainText(item.bookName),
        cover: httpsUrl(item.coverWap),
        episode_count: Number(item.totalChapterNum) || 0,
        tags: Array.isArray(item.bookTypeThree) ? item.bookTypeThree.map((tag) => plainText(tag?.name)).filter(Boolean).slice(0, 4) : [],
        source: "hema",
        url: `${ORIGIN}/drama/${item.bookId}`
      })).filter((item) => {
        if (seen.has(item.series_id)) return false;
        seen.add(item.series_id);
        return true;
      });
      return results;
    }
    function pageData(html) {
      const match = typeof html === "string" && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      try {
        const data = JSON.parse(match?.[1]).props.pageProps;
        if (!data || typeof data !== "object") throw new Error("invalid page");
        return data;
      } catch (_) {
        throw new Error("\u6CB3\u9A6C\u76EE\u5F55\u6570\u636E\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
    }
    async function browseList(options = {}) {
      try {
        const { genre = "", page = 1, forceRefresh = false } = options || {};
        const pg = Number(page);
        const slug = String(genre || "0");
        if (!Number.isSafeInteger(pg) || pg < 1 || !/^\d{1,30}(?:-\d{1,30}){0,15}$/.test(slug)) {
          throw new Error("\u6CB3\u9A6C\u9898\u6750\u6216\u9875\u7801\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
        }
        let firstHtml;
        if (forceRefresh || !genreCache || genreCache.expires <= Date.now()) {
          firstHtml = await request("/browse");
          const directory = pageData(firstHtml);
          if (!Array.isArray(directory.typeThreeList)) throw new Error("\u6CB3\u9A6C\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u9898\u6750\uFF0C\u8BF7\u91CD\u8BD5");
          const seen = /* @__PURE__ */ new Set();
          const items = directory.typeThreeList.filter((item) => Array.isArray(item?.typeThreeIds) && item.typeThreeIds.length > 0 && item.typeThreeIds.length <= 16 && item.typeThreeIds.every((id) => ID.test(String(id))) && plainText(item.name)).map((item) => ({ slug: item.typeThreeIds.join("-"), label: plainText(item.name) })).filter((item) => {
            if (item.slug === "0" || seen.has(item.slug)) return false;
            seen.add(item.slug);
            return true;
          });
          if (!items.length) throw new Error("\u6CB3\u9A6C\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u9898\u6750\uFF0C\u8BF7\u91CD\u8BD5");
          genreCache = { items, expires: Date.now() + 3e5 };
        }
        if (slug !== "0" && !genreCache.items.some((item) => item.slug === slug)) throw new Error("\u6CB3\u9A6C\u9898\u6750\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
        const apiPath = slug === "0" && pg === 1 ? "/browse" : `/browse/${slug}${pg > 1 ? `/${pg}` : ""}`;
        const html = apiPath === "/browse" && firstHtml ? firstHtml : await request(apiPath);
        const data = pageData(html);
        if (!Array.isArray(data.bookList) || Number(data.page) !== pg || String(data.typeThreeId || "0") !== slug) {
          throw new Error("\u6CB3\u9A6C\u8FD4\u56DE\u7684\u76EE\u5F55\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u91CD\u8BD5");
        }
        const results = normalizeBooks(data.bookList);
        const hasMore = results.length > 0 && new RegExp(`<a\\b[^>]*\\shref=["']/browse/${slug}/${pg + 1}["']`).test(html);
        return {
          success: true,
          results,
          page: pg,
          total: 0,
          totalPages: 0,
          hasMore,
          nextPage: hasMore ? pg + 1 : null,
          genres: genreCache.items,
          pageTitle: "\u6CB3\u9A6C\u77ED\u5267",
          sourceUrl: ORIGIN + apiPath
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function search(keyword, page = 1, options = {}) {
      try {
        const kw = String(keyword || "").trim();
        if (!kw) throw new Error("\u8BF7\u8F93\u5165\u641C\u7D22\u5173\u952E\u8BCD");
        const pg = Math.max(1, Number.parseInt(page, 10) || 1);
        const response = await request("/seo/video/6007", { sourceType: 1, keyword: kw, index: pg }, options);
        if (response?.retCode !== 0 || !Array.isArray(response.data?.bookList)) throw new Error("\u6CB3\u9A6C\u641C\u7D22\u6570\u636E\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        const data = response.data;
        const results = normalizeBooks(data.bookList);
        const hasMore = data.isMore === 1 && results.length > 0;
        return {
          success: true,
          results,
          page: pg,
          total: Number(data.totalSize) || 0,
          totalPages: 0,
          hasMore,
          nextPage: hasMore ? pg + 1 : null,
          genres: [],
          pageTitle: "\u6CB3\u9A6C\u77ED\u5267",
          sourceUrl: ORIGIN
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function detail(seriesId) {
      const { bookId } = parseId(seriesId);
      const html = await request(`/drama/${bookId}`);
      const match = typeof html === "string" && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      let result;
      try {
        result = JSON.parse(match?.[1]).props.pageProps;
      } catch (_) {
        throw new Error("\u6CB3\u9A6C\u8BE6\u60C5\u6570\u636E\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
      if (String(result?.bookInfoVo?.bookId) !== bookId || !Array.isArray(result?.chapterList)) {
        throw new Error("\u6CB3\u9A6C\u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
      }
      const seen = /* @__PURE__ */ new Set();
      for (const episode of result.chapterList) {
        const id = String(episode?.chapterId || "");
        if (!ID.test(id) || seen.has(id) || episode.bookId != null && String(episode.bookId) !== bookId) {
          throw new Error("\u6CB3\u9A6C\u5206\u96C6\u6570\u636E\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        }
        seen.add(id);
      }
      return result;
    }
    async function fetchEpisodeList2(seriesId) {
      const result = await detail(seriesId);
      const series_title = plainText(result.bookInfoVo.bookName) || "\u672A\u547D\u540D\u77ED\u5267";
      const cover = httpsUrl(result.bookInfoVo.coverWap);
      const episodes = result.chapterList.map((episode, index) => ({
        vid: `${seriesId}:${episode.chapterId}`,
        vid_index: Number(episode.chapterIndex) || index + 1,
        title: plainText(episode.chapterName),
        series_id: seriesId,
        series_title,
        cover,
        locked: episode.isCharge !== "0",
        source: "hema"
      })).sort((a, b) => a.vid_index - b.vid_index);
      if (!episodes.length) throw new Error("\u6CB3\u9A6C\u5206\u96C6\u5217\u8868\u4E3A\u7A7A");
      return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: "hema" };
    }
    async function fetchPlayUrlSingle2(vid, sid) {
      try {
        const id = parseId(vid, true);
        if (sid != null && sid !== "" && parseId(sid).seriesId !== id.seriesId) throw new Error("\u6CB3\u9A6C\u5206\u96C6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5267\u96C6");
        const result = await detail(id.seriesId);
        const episode = result.chapterList.find((item) => String(item.chapterId) === id.chapterId);
        if (!episode) throw new Error("\u6CB3\u9A6C\u672A\u627E\u5230\u8BE5\u5206\u96C6");
        if (episode.isCharge !== "0") return {
          url: null,
          spadeA: null,
          codec: null,
          source: "hema",
          locked: true,
          error: `\u7B2C ${Number(episode.chapterIndex) || ""} \u96C6\u5F53\u524D\u9501\u5B9A\uFF0C\u8BF7\u5728\u6CB3\u9A6C\u5B98\u65B9\u5E73\u53F0\u786E\u8BA4\u53EF\u770B\u8303\u56F4`
        };
        const url = httpsUrl(episode.chapterVideoVo?.mp4720p) || httpsUrl(episode.chapterVideoVo?.mp4);
        if (!url) throw new Error("\u6CB3\u9A6C\u672A\u63D0\u4F9B\u6709\u6548 HTTPS \u64AD\u653E\u5730\u5740");
        return { url, spadeA: null, codec: "", source: "hema" };
      } catch (error) {
        return { url: null, spadeA: null, codec: null, source: "hema", error: error.message };
      }
    }
    module2.exports = { browseList, search, fetchEpisodeList: fetchEpisodeList2, fetchPlayUrlSingle: fetchPlayUrlSingle2 };
  }
});

// src/native/xifan.js
var require_xifan = __commonJS({
  "src/native/xifan.js"(exports2, module2) {
    var axios2 = require_axios();
    var { isPublicMediaUrl: isPublicMediaUrl2 } = require_web_media_guard();
    var API2 = "https://xifan-api-cn.youlishipin.com";
    var ID = /^[a-zA-Z0-9_-]{1,200}$/;
    var genreCache;
    function plainText(value) {
      return String(value || "").replace(/<[^>]*>/g, "").trim();
    }
    function parseId(value, episode = false) {
      const parts = String(value || "").split(":");
      if (parts[0] !== "xifan" || parts.length !== (episode ? 4 : 3) || !parts.slice(1).every((part) => ID.test(part))) {
        throw new Error("\u897F\u996D\u5267\u96C6\u7F16\u53F7\u65E0\u6548");
      }
      return { source: parts[1], duanjuId: parts[2], episodeId: parts[3], seriesId: parts.slice(0, 3).join(":") };
    }
    function httpsUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && isPublicMediaUrl2(url.href) ? url.href : "";
      } catch (_) {
        return "";
      }
    }
    async function request(apiPath, params, options = {}) {
      const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 1e4;
      if (remaining <= 0) throw new Error("\u897F\u996D\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5");
      const timeout = Math.min(1e4, remaining);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const { data } = await axios2.get(API2 + apiPath, {
          params: { ...params, version: 2001001, androidVersionCode: 28 },
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
          timeout,
          signal: controller.signal,
          maxRedirects: 0,
          maxContentLength: 8 * 1024 * 1024
        });
        if (data?.ret !== 0 || !data.result || typeof data.result !== "object") throw new Error("invalid result");
        return data.result;
      } catch (_) {
        throw new Error(controller.signal.aborted ? "\u897F\u996D\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : "\u897F\u996D\u6765\u6E90\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      } finally {
        clearTimeout(timer);
      }
    }
    function contents(result) {
      return (Array.isArray(result.elements) ? result.elements : []).flatMap((element) => Array.isArray(element?.contents) ? element.contents : []);
    }
    async function genres(forceRefresh) {
      if (!forceRefresh && genreCache?.expires > Date.now()) return genreCache.items;
      const result = await request("/xifan/drama/portalPage", { reqType: "duanjuCategory" });
      const seen = /* @__PURE__ */ new Set();
      const items = contents(result).flatMap((item) => {
        const category = item.categoryItemVo;
        return category ? Array.isArray(category.subCategories) ? category.subCategories : [category] : [];
      }).filter((item) => Number.isSafeInteger(item.categoryId) && item.categoryId > 0 && plainText(item.oppoCategory)).map((item) => ({
        slug: `${item.categoryId}-${Buffer.from(item.oppoCategory).toString("hex")}`,
        label: plainText(item.oppoCategory),
        categoryId: item.categoryId,
        version: Number(item.version) || 1
      })).filter((item) => {
        if (seen.has(item.slug)) return false;
        seen.add(item.slug);
        return true;
      });
      if (!items.length) throw new Error("\u897F\u996D\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u5206\u7C7B\uFF0C\u8BF7\u91CD\u8BD5");
      genreCache = { expires: Date.now() + 3e5, items };
      return items;
    }
    function normalizeList(result, page, categoryItems = []) {
      const seen = /* @__PURE__ */ new Set();
      const results = contents(result).map((item) => item.duanjuVo).filter((item) => item && ID.test(String(item.source || "")) && ID.test(String(item.duanjuId || "")) && plainText(item.title)).map((item) => ({
        series_id: `xifan:${item.source}:${item.duanjuId}`,
        series_title: plainText(item.title),
        cover: httpsUrl(item.coverImageUrl),
        episode_count: Number(item.total) || 0,
        tags: Array.isArray(item.categories) ? item.categories.map(plainText).filter(Boolean).slice(0, 4) : [],
        source: "xifan",
        url: ""
      })).filter((item) => {
        if (seen.has(item.series_id)) return false;
        seen.add(item.series_id);
        return true;
      });
      const hasMore = result.hasMore === true && results.length > 0;
      return {
        success: true,
        results,
        page,
        total: 0,
        totalPages: 0,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        genres: categoryItems.map(({ slug, label }) => ({ slug, label })),
        pageTitle: "\u897F\u996D\u77ED\u5267",
        sourceUrl: ""
      };
    }
    async function browseList(options = {}) {
      try {
        const { genre = "", page = 1, forceRefresh = false } = options || {};
        const pg = Math.max(1, Number.parseInt(page, 10) || 1);
        const items = await genres(forceRefresh);
        const selected = genre ? items.find((item) => item.slug === genre) : items.find((item) => item.label === "\u90FD\u5E02") || items[0];
        if (!selected) throw new Error("\u897F\u996D\u9898\u6750\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
        const result = await request("/xifan/drama/portalPage", {
          reqType: "aggregationPage",
          offset: (pg - 1) * 30,
          categoryId: selected.categoryId,
          categoryNames: selected.label,
          categoryVersion: selected.version
        });
        return normalizeList(result, pg, items);
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function search(keyword, page = 1, options = {}) {
      try {
        const kw = String(keyword || "").trim();
        if (!kw) throw new Error("\u8BF7\u8F93\u5165\u641C\u7D22\u5173\u952E\u8BCD");
        const pg = Math.max(1, Number.parseInt(page, 10) || 1);
        return normalizeList(await request("/xifan/search/getSearchList", { keyword: kw, pageIndex: pg }, options), pg);
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    async function detail(seriesId) {
      const { source, duanjuId } = parseId(seriesId);
      const result = await request("/xifan/drama/getDuanjuInfo", { source, duanjuId });
      if (result.source !== source || String(result.duanjuId) !== duanjuId || !Array.isArray(result.episodeList)) {
        throw new Error("\u897F\u996D\u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
      }
      return result;
    }
    var VERIFIED_TITLE_CONFLICTS = /* @__PURE__ */ new Map([
      ["xifan:jiuzhou:253\0\u5929\u9F99\u6218\u795E", /* @__PURE__ */ new Set(["\u7231\u5F52\u826F\u8FB0"])]
    ]);
    function episodeDisplayTitle(seriesId, seriesTitle, title) {
      const blocked = VERIFIED_TITLE_CONFLICTS.get(`${seriesId}\0${seriesTitle}`);
      return blocked?.has(title) ? "" : title;
    }
    async function fetchEpisodeList2(seriesId) {
      const result = await detail(seriesId);
      const series_title = plainText(result.title) || "\u672A\u547D\u540D\u77ED\u5267";
      const cover = httpsUrl(result.coverImageUrl);
      const episodes = result.episodeList.filter((episode) => ID.test(String(episode.episodeId || ""))).map((episode) => ({
        vid: `${seriesId}:${episode.episodeId}`,
        vid_index: Number(episode.index) || 0,
        title: episodeDisplayTitle(seriesId, series_title, plainText(episode.title)),
        series_id: seriesId,
        series_title,
        cover,
        locked: episode.unlock !== true,
        source: "xifan"
      })).sort((a, b) => a.vid_index - b.vid_index);
      if (!episodes.length) throw new Error("\u897F\u996D\u5206\u96C6\u5217\u8868\u4E3A\u7A7A");
      return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: "xifan" };
    }
    async function fetchPlayUrlSingle2(vid, sid) {
      try {
        const id = parseId(vid, true);
        if (sid && String(sid) !== id.seriesId) throw new Error("\u897F\u996D\u5206\u96C6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5267\u96C6");
        const result = await detail(id.seriesId);
        const episode = result.episodeList.find((item) => String(item.episodeId) === id.episodeId);
        if (!episode) throw new Error("\u897F\u996D\u672A\u627E\u5230\u8BE5\u5206\u96C6");
        if (episode.unlock !== true) return {
          url: null,
          spadeA: null,
          codec: null,
          source: "xifan",
          locked: true,
          error: `\u7B2C ${Number(episode.index) || ""} \u96C6\u5F53\u524D\u9501\u5B9A\uFF0C\u8BF7\u5728\u897F\u996D\u5B98\u65B9 App \u786E\u8BA4\u53EF\u770B\u8303\u56F4`
        };
        const url = httpsUrl(episode.playUrl);
        if (!url) throw new Error("\u897F\u996D\u672A\u63D0\u4F9B\u6709\u6548 HTTPS \u64AD\u653E\u5730\u5740");
        return { url, spadeA: null, codec: "", source: "xifan" };
      } catch (error) {
        return { url: null, spadeA: null, codec: null, source: "xifan", error: error.message };
      }
    }
    module2.exports = { browseList, search, fetchEpisodeList: fetchEpisodeList2, fetchPlayUrlSingle: fetchPlayUrlSingle2, episodeDisplayTitle };
  }
});

// src/native/playback-device.js
var require_playback_device = __commonJS({
  "src/native/playback-device.js"(exports2, module2) {
    var crypto2 = require("node:crypto");
    var { gzipSync } = require("node:zlib");
    var { abortError: abortError2, throwIfAborted: throwIfAborted2, boundedSignal, networkFailure } = require_request_signal();
    var REGISTER_URL = "https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1";
    var KDF_SALT = Buffer.from("4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58", "hex");
    var registration;
    var retryAfter = 0;
    var registrationRetryAfter = 0;
    var lastRegistrationFailure;
    var lastNetworkFailure;
    function responseId(response, name) {
      const preferred = response?.[`${name}_str`];
      const value = preferred === void 0 || preferred === null || preferred === "" ? response?.[name] : preferred;
      if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
      return typeof value === "string" && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : "";
    }
    async function registerPlaybackDevice(requestJson, { signal } = {}) {
      throwIfAborted2(signal);
      if (Date.now() < registrationRetryAfter) throw Object.assign(new Error("\u533F\u540D\u64AD\u653E\u8BBE\u5907\u6CE8\u518C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\uFF0C10 \u79D2\u540E\u91CD\u8BD5"), {
        code: "DEVICE_REGISTRATION_FAILED",
        registrationFailure: lastRegistrationFailure,
        ...lastNetworkFailure ? { networkFailure: lastNetworkFailure } : {}
      });
      const request = boundedSignal(signal, 8e3);
      try {
        throwIfAborted2(request.signal);
        const now = Date.now();
        const cdid = crypto2.randomUUID();
        const header = {
          display_name: "\u7EA2\u679C\u514D\u8D39\u77ED\u5267",
          update_version_code: 73932,
          manifest_version_code: 73932,
          app_version_minor: "7.3.9.32",
          aid: 8662,
          channel: "update_64",
          package: "com.phoenix.read",
          app_version: "7.3.9.32",
          version_code: 73932,
          sdk_version: "3.7.0-rc.34-fanqie-xiaoshuo",
          sdk_target_version: 29,
          git_hash: "3a88f4e",
          os: "Android",
          os_version: "16",
          os_api: 36,
          device_model: "25053RT47C",
          device_brand: "Redmi",
          device_manufacturer: "Redmi",
          cpu_abi: "arm64-v8a",
          release_build: "b5e187f",
          density_dpi: 520,
          display_density: "mdpi",
          resolution: "1280x2772",
          language: "zh",
          timezone: 8,
          access: "wifi",
          not_request_sender: 0,
          carrier: "CHINA MOBILE",
          mcc_mnc: "46000",
          rom: "eng.root.20231116.160340",
          rom_version: "W528JS release-keys",
          cdid,
          sig_hash: "56a962410c494bbaf0b58dba20cae56f",
          openudid: crypto2.randomBytes(8).toString("hex"),
          clientudid: crypto2.randomUUID(),
          ipv6_list: [],
          region: "CN",
          tz_name: "Asia/Shanghai",
          tz_offset: 28800,
          sim_region: "cn",
          sim_serial_number: [],
          oaid_may_support: false,
          req_id: crypto2.randomUUID(),
          device_platform: "android",
          custom: { account_region_src: "fallback", account_region: "cn", host_bit: 64, dragon_device_type: "phone" },
          pre_installed_channel: "",
          apk_first_install_time: now,
          is_system_app: 0,
          sdk_flavor: "china",
          guest_mode: 0
        };
        const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: "ss_app_log", header, _gen_time: now })));
        const random = crypto2.randomBytes(32);
        const derived = crypto2.createHash("sha512").update(Buffer.concat([
          crypto2.createHash("sha512").update(random).digest(),
          KDF_SALT
        ])).digest();
        const cipher = crypto2.createCipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
        const plaintext = Buffer.concat([crypto2.createHash("sha512").update(compressed).digest(), compressed]);
        const data = Buffer.concat([Buffer.from("746305100000", "hex"), random, cipher.update(plaintext), cipher.final()]);
        const response = await requestJson(REGISTER_URL, {
          method: "POST",
          headers: {
            "User-Agent": "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)",
            Accept: "application/json",
            "Content-Type": "application/octet-stream;tt-data=a",
            "log-encode-type": "gzip",
            "x-ss-dp": "8662",
            "x-ss-req-ticket": String(now),
            "x-vc-bdturing-sdk-version": "4.0.3.cn",
            lc: "101",
            "sdk-version": "2",
            "passport-sdk-version": "5051452",
            "x-neptune": "-8|50:51:59:30:40:47:49:39",
            "x-ss-stub": crypto2.createHash("md5").update(data).digest("hex").toUpperCase()
          },
          data
        }, Date.now() + 8e3, request.signal);
        throwIfAborted2(request.signal);
        const device_id = responseId(response, "device_id");
        const iid = responseId(response, "install_id");
        if (Number(response?.code ?? response?.Code ?? 0) !== 0) throw Object.assign(new Error("Registration rejected"), { code: "BUSINESS_REJECTED" });
        if (!device_id || !iid) throw Object.assign(new Error("Invalid registration"), { code: "INVALID_RESPONSE" });
        registrationRetryAfter = 0;
        return Object.freeze({ device_id, iid, cdid });
      } catch (error) {
        if (request.signal.aborted) error = abortError2(request.signal);
        if (error?.code === "ERR_CANCELED") throw abortError2();
        const status = Number(error?.status);
        const detail = networkFailure(error?.code);
        const registrationFailure = Number.isInteger(status) && status >= 300 && status <= 599 ? `HTTP_${status}` : ["ECONNABORTED", "ETIMEDOUT"].includes(error?.code) ? "TIMEOUT" : detail || error?.code === "ERR_NETWORK" ? "NETWORK_ERROR" : ["EMPTY_RESPONSE", "INVALID_RESPONSE", "BUSINESS_REJECTED", "SECURITY_BLOCKED"].includes(error?.code) ? error.code : "UNKNOWN";
        registrationRetryAfter = Date.now() + 1e4;
        lastRegistrationFailure = registrationFailure;
        lastNetworkFailure = registrationFailure === "NETWORK_ERROR" ? detail : void 0;
        throw Object.assign(new Error("\u533F\u540D\u64AD\u653E\u8BBE\u5907\u6CE8\u518C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\uFF0C10 \u79D2\u540E\u91CD\u8BD5"), {
          code: "DEVICE_REGISTRATION_FAILED",
          registrationFailure,
          ...lastNetworkFailure ? { networkFailure: lastNetworkFailure } : {}
        });
      } finally {
        request.dispose();
      }
    }
    function getPlaybackDevice(requestJson) {
      if (retryAfter && Date.now() >= retryAfter) {
        registration = void 0;
        retryAfter = 0;
      }
      registration ||= Promise.resolve().then(() => registerPlaybackDevice(requestJson)).catch((error) => {
        if (error.code === "ERR_CANCELED") registration = void 0;
        else retryAfter = Date.now() + 1e4;
        throw error;
      });
      return registration;
    }
    module2.exports = { getPlaybackDevice, registerPlaybackDevice };
  }
});

// src/native/sm3.js
var require_sm3 = __commonJS({
  "src/native/sm3.js"(exports2, module2) {
    module2.exports = function sm3(input) {
      const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
      const data = Buffer.alloc(Math.ceil((source.length + 9) / 64) * 64);
      source.copy(data);
      data[source.length] = 128;
      data.writeBigUInt64BE(BigInt(source.length) * 8n, data.length - 8);
      const state = new Uint32Array([1937774191, 1226093241, 388252375, 3666478592, 2842636476, 372324522, 3817729613, 2969243214]);
      const words = new Uint32Array(68);
      const rotate = (x, n) => (x << (n & 31) | x >>> (32 - n & 31)) >>> 0;
      for (let offset = 0; offset < data.length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = data.readUInt32BE(offset + i * 4);
        for (let i = 16; i < 68; i++) {
          const x = words[i - 16] ^ words[i - 9] ^ rotate(words[i - 3], 15);
          words[i] = x ^ rotate(x, 15) ^ rotate(x, 23) ^ rotate(words[i - 13], 7) ^ words[i - 6];
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let i = 0; i < 64; i++) {
          const a12 = rotate(a, 12);
          const s1 = rotate(a12 + e + rotate(i < 16 ? 2043430169 : 2055708042, i) >>> 0, 7);
          const s2 = s1 ^ a12;
          const ff = i < 16 ? a ^ b ^ c : a & b | a & c | b & c;
          const gg = i < 16 ? e ^ f ^ g : e & f | ~e & g;
          const t1 = ff + d + s2 + (words[i] ^ words[i + 4]) >>> 0;
          const t2 = gg + h + s1 + words[i] >>> 0;
          d = c;
          c = rotate(b, 9);
          b = a;
          a = t1;
          h = g;
          g = rotate(f, 19);
          f = e;
          e = (t2 ^ rotate(t2, 9) ^ rotate(t2, 17)) >>> 0;
        }
        const next = [a, b, c, d, e, f, g, h];
        for (let i = 0; i < 8; i++) state[i] ^= next[i];
      }
      const digest = Buffer.alloc(32);
      for (let i = 0; i < 8; i++) digest.writeUInt32BE(state[i], i * 4);
      return digest;
    };
  }
});

// src/native/playback-signature.js
var require_playback_signature = __commonJS({
  "src/native/playback-signature.js"(exports2, module2) {
    var crypto2 = require("node:crypto");
    var sm3 = require_sm3();
    var LICENSE_ID = 1611921764n;
    var SIGN_KEY = Buffer.from("fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304", "hex");
    var AES_KEY = Buffer.from("d31e3718288a1027baab59f146a09a9c", "hex");
    var AES_IV = Buffer.from("ea180a0336ed352fcd24e4d50018ae54", "hex");
    var MAGIC8 = Buffer.from("f2f7fcfff2f7fcff", "hex");
    var TAIL9 = Buffer.from("eafb2cfe8568519154", "hex");
    var u64 = (value) => BigInt.asUintN(64, value);
    var rol64 = (value, bits) => u64(u64(value) << BigInt(bits) | u64(value) >> BigInt(64 - bits));
    var ror64 = (value, bits) => rol64(value, 64 - bits);
    var integer = (value) => {
      if (typeof value === "bigint") return value;
      if (!Number.isSafeInteger(value)) throw new TypeError("Safe integer or BigInt required");
      return BigInt(value);
    };
    var le64 = (value) => {
      const out = Buffer.alloc(8);
      out.writeBigUInt64LE(u64(value));
      return out;
    };
    function varint(value) {
      let n = BigInt.asUintN(32, integer(value));
      const out = [];
      while (n >= 128n) {
        out.push(Number(n & 127n) | 128);
        n >>= 7n;
      }
      out.push(Number(n));
      return Buffer.from(out);
    }
    var ProtoBuf = class {
      constructor() {
        this.parts = [];
      }
      putVarint(tag, value) {
        this.parts.push(varint(BigInt(tag) << 3n), varint(value));
        return this;
      }
      putBytes(tag, bytes) {
        const value = Buffer.from(bytes);
        this.parts.push(varint(BigInt(tag) << 3n | 2n), varint(value.length), value);
        return this;
      }
      putUtf8(tag, value) {
        return this.putBytes(tag, Buffer.from(value, "utf8"));
      }
      putProtobuf(tag, value) {
        return this.putBytes(tag, value.toBuf());
      }
      toBuf() {
        return Buffer.concat(this.parts);
      }
    };
    var Simon = {
      keyExpansion(key) {
        if (!Array.isArray(key) || key.length !== 4) throw new TypeError("Four Simon key words required");
        const expanded = key.map((value) => u64(integer(value)));
        for (let i = 4; i < 72; i++) {
          let tmp = ror64(expanded[i - 1], 3) ^ expanded[i - 3];
          tmp ^= ror64(tmp, 1);
          const bit = 0x3dc94c3a046d678bn >> BigInt((i - 4) % 62) & 1n;
          expanded.push(u64(~expanded[i - 4] ^ tmp ^ bit ^ 3n));
        }
        return expanded;
      },
      encrypt(left, right, key) {
        let x = u64(integer(left)), y = u64(integer(right));
        for (const roundKey of Simon.keyExpansion(key)) {
          const previous = y;
          y = u64(x ^ rol64(y, 1) & rol64(y, 8) ^ rol64(y, 2) ^ roundKey);
          x = previous;
        }
        return [x, y];
      }
    };
    var pad16 = (data) => Buffer.concat([data, Buffer.alloc(16 - data.length % 16, 16 - data.length % 16)]);
    function queryParam(query, name) {
      const decode = (value) => {
        try {
          return decodeURIComponent(value.replace(/\+/g, " "));
        } catch {
          return value;
        }
      };
      for (const part of query.split("&")) {
        const at = part.indexOf("="), key = at < 0 ? part : part.slice(0, at);
        if (decode(key) === name) return decode(at < 0 ? "" : part.slice(at + 1));
      }
      return null;
    }
    var Argus = {
      bodyHash(stubHex) {
        if (!stubHex) return sm3(Buffer.alloc(16)).subarray(0, 6);
        const bytes = /^(?:[a-f\d]{2})+$/i.test(stubHex) ? Buffer.from(stubHex, "hex") : Buffer.alloc(0);
        return sm3(bytes).subarray(0, 6);
      },
      queryHash(query) {
        return sm3(query ? Buffer.from(query, "utf8") : Buffer.alloc(16)).subarray(0, 6);
      },
      sign(query, stubHex, ts, aid, licenseId, deviceId, installId, randField) {
        if (typeof query !== "string" || typeof stubHex !== "string" || typeof deviceId !== "string" || typeof installId !== "string") throw new TypeError("String protocol fields required");
        const bean = new ProtoBuf().putVarint(1, 1077940818).putVarint(2, 2).putVarint(3, randField).putUtf8(4, String(integer(aid) === 0n ? 1967n : integer(aid))).putUtf8(5, deviceId).putUtf8(6, String(integer(licenseId) === 0n ? LICENSE_ID : integer(licenseId))).putUtf8(7, queryParam(query, "version_name") || "").putUtf8(8, "v04.04.05-ov-android").putVarint(9, 134744640).putBytes(10, Buffer.alloc(8)).putVarint(11, 0).putVarint(12, integer(ts) << 1n).putBytes(13, Argus.bodyHash(stubHex)).putBytes(14, Argus.queryHash(query)).putProtobuf(15, new ProtoBuf().putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 3348294860)).putUtf8(16, installId).putUtf8(20, "none").putVarint(21, 738).putProtobuf(23, new ProtoBuf().putUtf8(1, "NX551J").putVarint(2, 8196).putVarint(4, 2162219008)).putVarint(25, 2);
        const protobuf = pad16(bean.toBuf()), key = Array.from({ length: 4 }, (_, i) => SIGN_KEY.readBigUInt64LE(i * 8));
        const blocks = [];
        for (let at = 0; at < protobuf.length; at += 16) {
          const encrypted = Simon.encrypt(protobuf.readBigUInt64LE(at), protobuf.readBigUInt64LE(at + 8), key);
          blocks.push(le64(encrypted[0]), le64(encrypted[1]));
        }
        const framed = Buffer.concat([MAGIC8, ...blocks, TAIL9]);
        for (let i = 8; i < framed.length; i++) framed[i] ^= MAGIC8[i % 8];
        const padded = pad16(Buffer.concat([framed.reverse(), Buffer.from("ao", "ascii")]));
        const cipher = crypto2.createCipheriv("aes-128-cbc", AES_KEY, AES_IV);
        cipher.setAutoPadding(false);
        return Buffer.concat([Buffer.from("f281", "hex"), cipher.update(padded), cipher.final()]).toString("base64");
      }
    };
    var Ladon = {
      encrypt(ts, licenseId, aid, randomBytes) {
        if (!Buffer.isBuffer(randomBytes) || randomBytes.length !== 4) throw new TypeError("Four Ladon random bytes required");
        const aidText = integer(aid).toString();
        const digest = crypto2.createHash("md5").update(Buffer.concat([randomBytes, Buffer.from(aidText)])).digest("hex");
        const ascii = Buffer.from(digest, "ascii"), words = Array.from({ length: 4 }, (_, i) => ascii.readBigUInt64LE(i * 8));
        const table = [words[0]], queue = words.slice(2);
        let b0 = words[0], b8 = words[1];
        for (let i = 0; i < 34; i++) {
          let x8 = u64(ror64(b8, 8) + b0) ^ BigInt(i);
          queue.push(x8);
          x8 ^= rol64(b0, 3);
          table.push(u64(x8));
          b0 = u64(x8);
          b8 = queue.shift();
        }
        const input = pad16(Buffer.from(`${integer(ts)}-${integer(licenseId)}-${aidText}`, "ascii")), out = Buffer.alloc(input.length);
        for (let at = 0; at < input.length; at += 16) {
          let a = input.readBigUInt64LE(at), b = input.readBigUInt64LE(at + 8);
          for (let i = 0; i < 34; i++) {
            b = table[i] ^ u64(a + ror64(b, 8));
            a = b ^ rol64(a, 3);
          }
          out.writeBigUInt64LE(u64(a), at);
          out.writeBigUInt64LE(u64(b), at + 8);
        }
        return Buffer.concat([randomBytes, out]).toString("base64");
      }
    };
    function signPlayer({ query, body = null, ts, randField, ladonRandom }) {
      if (typeof query !== "string" || body !== null && !Buffer.isBuffer(body)) throw new TypeError("Final query string and raw Buffer body required");
      const aidValue = queryParam(query, "aid");
      let aid = 1967n;
      if (/^[+-]?\d+$/.test(aidValue || "")) {
        const candidate = BigInt(aidValue);
        if (candidate >= -(1n << 63n) && candidate < 1n << 63n) aid = candidate;
      }
      const timestamp = integer(ts), stub = body?.length ? crypto2.createHash("md5").update(body).digest("hex") : "";
      if (randField === void 0) randField = crypto2.randomBytes(4).readInt32LE();
      if (ladonRandom === void 0) ladonRandom = crypto2.randomBytes(4);
      const headers = {
        "x-ss-req-ticket": String(timestamp * 1000n),
        "x-khronos": String(timestamp),
        "x-ladon": Ladon.encrypt(timestamp, LICENSE_ID, aid, ladonRandom),
        "x-argus": Argus.sign(query, stub, timestamp, aid, LICENSE_ID, queryParam(query, "device_id") || "", "", randField)
      };
      if (stub) headers["x-ss-stub"] = stub;
      return headers;
    }
    module2.exports = { signPlayer, Argus, Ladon, ProtoBuf, Simon };
  }
});

// src/native/playback-v5.js
var require_playback_v5 = __commonJS({
  "src/native/playback-v5.js"(exports2, module2) {
    "use strict";
    var crypto2 = require("node:crypto");
    var { gunzipSync } = require("node:zlib");
    var sm3 = require_sm3();
    var PROCESS_NONCE = crypto2.randomBytes(18).toString("base64url");
    var PROCESS_STARTED = Date.now();
    var MAGIC = Buffer.from("2d4b4fca49750d433fb5ae2c226dcc56", "hex");
    var SIGN_KEY = Buffer.from("b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d", "hex");
    var SBOX = Buffer.from("53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0df37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1dd12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe127400248591238922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c894545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dccd759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8de0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd288fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5d09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac91fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443fd830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f44591681335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e", "hex");
    var HASH_TABLE = [3954593711, 128638146, 3476129727, 3759225087, 1829502207, 1513137086, 3021657656, 873991864, 4063488879, 2980414668, 3435335111, 1204935505, 3579204574, 1890078625, 1464286226, 4151247496, 738688778, 3658336976, 4223168364, 4257533696, 1753874957, 3866543782, 2362848139, 440175886, 3437801579, 1792077067, 2689738519, 3698437251, 579197809, 3585400230, 1936688720, 1700802668, 1635574438, 3827515774, 172024131, 1414414386, 2296380202, 1902910176, 1279687304, 95566771, 3788552294, 3131301048, 2922607827, 3275233872, 386070363, 4268598120, 4038381384, 1309670328, 1923797261, 650459709, 4072464630, 3025499521, 1243971549, 2352054946, 2869640070, 1029569300, 1326462516, 3548074711, 1146027798, 3943314385, 1822977902, 2640807, 137919738, 1605596550];
    var md5 = (value) => crypto2.createHash("md5").update(value).digest();
    var random32 = () => crypto2.randomBytes(4).readUInt32LE();
    var rol32 = (value, count) => (value << (count & 31) | value >>> (32 - count & 31)) >>> 0;
    var ror32 = (value, count) => rol32(value, -count);
    var u64 = (value) => BigInt.asUintN(64, value);
    var ror64 = (value, count) => u64(value >> BigInt(count) | value << BigInt(64 - count));
    function le32(value) {
      const out = Buffer.alloc(4);
      out.writeUInt32LE(value >>> 0);
      return out;
    }
    function xor(a, b) {
      return Buffer.from(a.map((value, i) => value ^ b[i]));
    }
    function varint(value) {
      let n = BigInt(value);
      const out = [];
      while (n > 127n) {
        out.push(Number(n & 127n) | 128);
        n >>= 7n;
      }
      out.push(Number(n));
      return Buffer.from(out);
    }
    function proto(fields) {
      return Buffer.concat(fields.map(([tag, value, type]) => {
        if (type === "sint") {
          const n = BigInt(value);
          return Buffer.concat([varint(tag * 8), varint(n < 0n ? -n * 2n - 1n : n * 2n)]);
        }
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return bytes.length ? Buffer.concat([varint(tag * 8 + 2), varint(bytes.length), bytes]) : Buffer.alloc(0);
      }));
    }
    function getIv(initial, bytes) {
      let value = initial;
      for (let i = 0; i < bytes.length; i++) value = (i & 1) === 0 ? value >>> 4 ^ value ^ value << 6 ^ bytes[i] : ~(value >>> 7 ^ value ^ (bytes[i] | value << 12));
      return value >>> 0;
    }
    function branch(query, body, ts) {
      return getIv(getIv(getIv(539167016, query), body), le32(ts)) & 15;
    }
    function sumMd5(bytes) {
      let check = 539100192;
      for (let i = 0; i < 12; i++) {
        const temp = check >>> ((i & 1) === 0 ? 3 : 5) ^ check;
        check = ((i & 1) === 0 ? bytes[i] ^ check << 7 : ~(bytes[i] | check << 11)) ^ temp;
      }
      return ((check | 4) ^ 16777216) >>> 0;
    }
    function hashF13(query, body, ts) {
      if (branch(query, body, ts) !== 12) throw new Error("Unsupported v5 hash branch");
      const seed = 2638911426, count = seed + ts >>> 0;
      const table = HASH_TABLE.map((value) => ror32(value, count + 1));
      const shift = count + 2 & 7;
      const pad = Buffer.from([250, 69, 97, 215].map((value) => (value | value << 8) >>> shift & 255));
      const data = Buffer.concat([query, body, le32(ts), pad, Buffer.from("00000000000001a0", "hex")]);
      const schedule = [];
      for (let i = 0; i < data.length; i += 4) schedule.push(data.readUInt32BE(i));
      for (let i = 0; i < 112; i++) {
        const x = schedule[i + 1], y = schedule[i + 14];
        schedule.push(schedule[i] + schedule[i + 9] + (rol32(x, 14) ^ rol32(x, 25) ^ x >>> 3) + (rol32(y, 13) ^ rol32(y, 15) ^ y >>> 10) >>> 0);
      }
      const initial = [2059030472, 1729520903, 1677982208, 873419055, 984304912, 3005047866, 2874125293, 2152413264].map((value) => ror32(value, count));
      const state = initial.slice();
      for (let i = 0; i < 96; i++) {
        const base = seed + i;
        const n1 = (state[4] ^ state[0]) & state[1] ^ state[4];
        const n2 = rol32(state[1], 26) ^ rol32(state[1], 21) ^ rol32(state[1], 7);
        const n4 = schedule[base & 127] + n1 + n2 + table[base & 63] + state[6] >>> 0;
        const n5 = rol32(state[3], 30) ^ rol32(state[3], 19) ^ rol32(state[3], 10);
        const n6 = state[3] & state[5] | (state[3] | state[5]) & state[2];
        const old = state[7];
        state.unshift(state.pop());
        state[7] = n5 + n6 + n4 >>> 0;
        state[0] = old + n4 >>> 0;
      }
      const output = Buffer.alloc(32);
      for (let i = 0; i < 8; i++) output.writeUInt32BE(state[i] + initial[i] >>> 0, i * 4);
      const folded = xor(output.subarray(0, 16), output.subarray(16));
      return Buffer.concat([folded, le32(sumMd5(folded) | 32)]);
    }
    var CarrierV5 = class {
      constructor(key, ts) {
        const word = ts & 3;
        this.box = SBOX.subarray(word * 256, (word + 1) * 256);
        this.con = [[2, 0, 3, 1], [1, 3, 2, 0], [3, 2, 1, 0], [2, 3, 1, 0]][word];
        this.order = [
          [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
          [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
          [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
          [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7]
        ][word];
        const initial = [3149258354, 3563294043, 2460350267, 2314772937][word];
        const expanded = Buffer.concat([xor(Buffer.concat(Array.from({ length: 4 }, () => le32(initial))), key), Buffer.alloc(32)]);
        let rounds = 8;
        for (let i = 4; i < 12; i++) {
          const at = 4 * (i - 1);
          let a = expanded[at], b = expanded[at + 1], c = expanded[at + 2], d = expanded[at + 3];
          if ((i & 3) === 0) {
            const temp = (initial >> (rounds & 24) ^ this.box[b]) & 255;
            b = this.box[c];
            c = this.box[d];
            d = this.box[a];
            a = temp;
          }
          rounds += 2;
          expanded[at + 4] = a ^ expanded[at - 12];
          expanded[at + 5] = b ^ expanded[at - 11];
          expanded[at + 6] = c ^ expanded[at - 10];
          expanded[at + 7] = d ^ expanded[at - 9];
        }
        this.keys = Array.from({ length: 12 }, (_, i) => expanded.subarray(i * 4, i * 4 + 4));
      }
      block(value) {
        let rows = Array.from({ length: 4 }, (_, i) => Array.from(value.subarray(i * 4, i * 4 + 4)));
        const add = (offset) => {
          for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rows[i][j] ^= this.keys[offset + i][this.con[j]];
        };
        add(0);
        for (let round = 1; round <= 2; round++) {
          const before = rows.map((row) => row.map((value2) => this.box[value2]));
          const flat = this.con.flatMap((i) => before[i]);
          rows = Array.from({ length: 4 }, (_, i) => this.order.slice(i * 4, i * 4 + 4).map((at) => flat[at]));
          if (round === 1) {
            rows = rows.map((row) => this.con.map((at) => row[at]));
            const xt = (x) => (x << 1 ^ (x & 128 ? 27 : 0)) & 255;
            for (let i = 0; i < 4; i++) {
              const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i], u = rows[0][i];
              rows[0][i] ^= t ^ xt(rows[0][i] ^ rows[1][i]);
              rows[1][i] ^= t ^ xt(rows[1][i] ^ rows[2][i]);
              rows[2][i] ^= t ^ xt(rows[2][i] ^ rows[3][i]);
              rows[3][i] ^= t ^ xt(rows[3][i] ^ u);
            }
          }
          add(round * 4);
        }
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rows[i][j] ^= this.keys[4 + i][j];
        return Buffer.from(rows.flat());
      }
      encrypt(source, iv) {
        if (source.length < 248) throw new RangeError("V5 carrier requires at least 248 bytes");
        const wire = [6, 5, 3, 4, 2, 7, 1, 0], compact = [1, 7, 3, 6, 2, 0, 4, 5];
        const plaintext = Buffer.alloc(32);
        for (let i = 0; i < 31; i++) for (let j = 0; j < 8; j++) {
          plaintext[i] |= (source[i * 8 + j] >>> wire[j] & 1) << compact[j];
        }
        plaintext[31] = 1;
        const first = this.block(xor(plaintext.subarray(0, 16), iv));
        const key = Buffer.concat([first, this.block(xor(plaintext.subarray(16), first))]);
        const output = Buffer.from(source);
        for (let i = 0; i < 31; i++) for (let j = 0; j < 8; j++) {
          const at = i * 8 + j;
          output[at] = output[at] & ~(1 << wire[j]) | (key[i] >>> compact[j] & 1) << wire[j];
        }
        return Buffer.concat([key.subarray(31), output]);
      }
    };
    function xmxor(data, key) {
      const encoded = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) {
        const at = i * 4 & 28, d0 = key[at], d1 = key[at + 1];
        let value = ~(((data[i] << 4 | data[i] >>> 4) & 255) + d0) ^ d1;
        value = ((value & 255) << 3 | (value & 255) >>> 5) & 255;
        encoded[data.length - i - 1] = ~(value + d1 & 255 ^ d0) & 255;
      }
      const last = encoded.at(-1) ^ encoded.at(-2), first = encoded[0];
      encoded[0] = ~last + first & 255;
      encoded[1] = (encoded[0] ^ encoded.at(-1) ^ 254) + encoded[1] & 255;
      encoded[2] = encoded[2] + (last - first ^ (encoded[1] << 3 | encoded[1] >>> 5) & 255 ^ 2) & 255;
      for (let i = 0; i < encoded.length - 4; i++) {
        const temp = (encoded[i + 2] << 3 | encoded[i + 2] >>> 5) & 255 ^ encoded[i + 1] ^ i + 3;
        encoded[i + 3] = ~temp + encoded[i + 3] & 255;
      }
      encoded[encoded.length - 1] ^= encoded.at(-2);
      let sum = 0;
      for (let i = 1; i < encoded.length; i++) sum += encoded[i];
      encoded[0] = (encoded[0] ^ encoded[1]) + sum & 255;
      return encoded;
    }
    function medusa(query, f13, ts, who) {
      const flags = Buffer.alloc(8);
      const device = proto([
        [1, 1, "sint"],
        [2, 2, "sint"],
        [3, "8662"],
        [4, who.device_id],
        [5, PROCESS_NONCE],
        [6, "!noperm!"],
        [12, "Asia/Shanghai,8"],
        [13, "zh_CN"],
        [22, who.os_version],
        [25, PROCESS_STARTED, "sint"],
        [30, who.device_type],
        [31, "HONOR"],
        [32, who.device_type],
        [34, "HONOR"]
      ]);
      const env = proto([[6, "v04.10.03.04-bugfix"], [8, who.channel], [12, device], [14, who.version_name]]);
      const message = proto([
        [1, MAGIC],
        [2, 5, "sint"],
        [3, random32(), "sint"],
        [4, "8662"],
        [5, who.device_id],
        [6, "646637794"],
        [7, who.version_name],
        [8, "v04.10.03-ml-android"],
        [9, 67764992, "sint"],
        [10, flags],
        [12, ts, "sint"],
        [13, f13],
        [14, query.subarray(0, 6)],
        [15, proto([[1, 1, "sint"], [2, 1, "sint"], [3, 1, "sint"], [5, 1, "sint"]])],
        [17, ts, "sint"],
        [20, "none"],
        [21, 377, "sint"],
        [23, env],
        [24, '{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}']
      ]);
      const nonce = random32(), high = nonce >>> 16 & 255;
      const hash = sm3(Buffer.concat([SIGN_KEY, le32(nonce), SIGN_KEY]));
      const seed = le32(~((high << 11 | nonce >>> 24) ^ high >>> 5 ^ high));
      const transformed = Buffer.concat([flags, xmxor(message, hash)]).reverse();
      for (let i = 0; i < transformed.length; i++) transformed[i] ^= seed[~i & 3];
      const check = 402653185 | (query[0] & 63) << 14 | (f13[0] & 63) << 8;
      const packed = Buffer.concat([
        Buffer.from([202]),
        le32(random32()),
        le32(check),
        transformed,
        Buffer.from([nonce >>> 16, nonce >>> 24])
      ]);
      const encrypted = new CarrierV5(md5(SIGN_KEY.subarray(0, 16)), ts).encrypt(packed, md5(SIGN_KEY.subarray(16)));
      const prefix = Buffer.concat([le32(5), MAGIC]), time = le32(ts);
      for (let i = 0; i < prefix.length; i++) prefix[i] ^= time[i & 3];
      return Buffer.concat([prefix, Buffer.from([nonce, nonce >>> 8, 0, 1]), encrypted]).toString("base64");
    }
    function helios(ts) {
      const nonce = le32(random32());
      const ascii = Buffer.from(md5(Buffer.concat([nonce, Buffer.from("8662")])).toString("hex"));
      const words = Array.from({ length: 4 }, (_, i) => ascii.readBigUInt64LE(i * 8));
      const table = [words[0]];
      let b0 = words.shift(), b8 = words.shift();
      for (let i = 0; i < 34; i++) {
        let value = u64(ror64(b8, 8) + b0) ^ BigInt(i);
        words.push(value);
        value = u64(value ^ ror64(b0, 61));
        table.push(value);
        b0 = value;
        b8 = words.shift();
      }
      const text = Buffer.from(`${ts}-646637794-8662`);
      const padding = 16 - text.length % 16;
      const data = Buffer.concat([text, Buffer.alloc(padding, padding)]), output = Buffer.alloc(data.length);
      for (let at = 0; at < data.length; at += 16) {
        let a = data.readBigUInt64LE(at), b = data.readBigUInt64LE(at + 8);
        for (let i = 0; i < 34; i++) {
          b = u64(table[i] ^ a + ror64(b, 8));
          a = u64(b ^ ror64(a, 61));
        }
        output.writeBigUInt64LE(a, at);
        output.writeBigUInt64LE(b, at + 8);
      }
      return Buffer.concat([nonce, output]).toString("base64");
    }
    function plainObject(value) {
      if (!value || typeof value !== "object") return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === null || Object.getPrototypeOf(prototype) === null;
    }
    function encode(value) {
      return encodeURIComponent(value).replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    }
    function validatedValues(values) {
      if (!plainObject(values) || Object.getOwnPropertySymbols(values).length) throw new TypeError("V5 values must be a plain string record");
      const result = /* @__PURE__ */ Object.create(null), entries = Object.entries(Object.getOwnPropertyDescriptors(values));
      if (entries.length > 128) throw new RangeError("Too many V5 query fields");
      for (const [key, descriptor] of entries) {
        const value = descriptor.value;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || !key || key.length > 128 || typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(key + value)) {
          throw new TypeError("V5 query fields must be bounded strings without control characters or accessors");
        }
        try {
          encode(key);
          encode(value);
        } catch {
          throw new TypeError("V5 query fields must be valid Unicode");
        }
        result[key] = value;
      }
      for (const key of ["device_id", "iid"]) {
        if (!/^[1-9]\d{0,29}$/.test(result[key] || "")) throw new TypeError(`V5 ${key} must be a positive decimal string`);
      }
      for (const key of ["cdid", "version_name", "channel", "os_version", "device_type"]) {
        if (!result[key] || !result[key].trim() || result[key].length > 128) throw new TypeError(`V5 ${key} is required and must be bounded`);
      }
      if (result.aid !== void 0 && result.aid !== "8662") throw new TypeError("V5 aid must be 8662");
      return result;
    }
    function signPlaybackV5(input) {
      if (!plainObject(input)) throw new TypeError("V5 signing options are required");
      const { base, values, body, now = Date.now() } = input;
      if (typeof base !== "string" || base.length > 8192 || /[\s?#]/.test(base)) throw new TypeError("V5 base must be an HTTPS URL without query or fragment");
      let parsed;
      try {
        parsed = new URL(base);
      } catch {
        throw new TypeError("V5 base must be a valid HTTPS URL");
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443") {
        throw new TypeError("V5 base must use HTTPS without credentials or a custom port");
      }
      if (!Number.isSafeInteger(now) || now < 0 || Math.floor(now / 1e3) > 2147483647) throw new RangeError("V5 now must be nonnegative integer milliseconds within signed timestamp range");
      const who = validatedValues(values);
      if (!Buffer.isBuffer(body)) throw new TypeError("V5 body must be the original gzip Buffer");
      if (body.length < 18 || body.length > 2 * 1024 * 1024 || body[0] !== 31 || body[1] !== 139 || body[2] !== 8) {
        throw new TypeError("V5 body must be a bounded gzip Buffer");
      }
      try {
        gunzipSync(body, { maxOutputLength: 2 * 1024 * 1024 });
      } catch {
        throw new TypeError("V5 body must contain valid bounded gzip data");
      }
      const ts = Math.floor(now / 1e3), bodyHash = md5(body);
      if (Object.hasOwn(who, "ts")) who.ts = String(ts);
      for (let offset = 0; offset < 1024; offset++) {
        const ticket = String(now + offset);
        const query = Object.entries({ ...who, _rticket: ticket }).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
        const queryHash = sm3(Buffer.from(query));
        if (branch(queryHash, bodyHash, ts) !== 12) continue;
        const f13 = hashF13(queryHash, bodyHash, ts);
        return { url: `${parsed.href}?${query}`, headers: {
          "x-khronos": String(ts),
          "x-helios": helios(ts),
          "x-medusa": medusa(queryHash, f13, ts, who),
          "x-ss-stub": bodyHash.toString("hex").toUpperCase(),
          "x-ss-req-ticket": ticket
        } };
      }
      throw new Error("Unable to select V5 playback signature branch within 1024 tickets");
    }
    module2.exports = { signPlaybackV5 };
  }
});

// src/native/app-source.js
var require_app_source = __commonJS({
  "src/native/app-source.js"(exports2, module2) {
    var crypto2 = require("node:crypto");
    var { gzipSync } = require("node:zlib");
    var { setTimeout: delay } = require("node:timers/promises");
    var { registerPlaybackDevice } = require_playback_device();
    var { signPlayer } = require_playback_signature();
    var { signPlaybackV5 } = require_playback_v5();
    var { abortError: abortError2, throwIfAborted: throwIfAborted2, boundedSignal, networkFailure } = require_request_signal();
    var sm3 = require_sm3();
    var { normalizeDownloadQuality: normalizeDownloadQuality2, meetsDownloadQuality } = require_download_quality();
    var localId = () => String(1000000000000000n + BigInt("0x" + crypto2.randomBytes(6).toString("hex")));
    var PROCESS_NONCE = crypto2.randomBytes(18).toString("base64url");
    var PROCESS_STARTED = Date.now();
    var playbackQueue = Promise.resolve();
    var playbackReadyAt = 0;
    var playbackRejection = null;
    var VIDEO_API = "https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/";
    var PLAYER_API = "https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1";
    var SEARCH_API = "https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v";
    var VIDEO_UA = "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
    var SEARCH_UA = "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";
    var DEVICE = {
      ac: "wifi",
      channel: "update_64",
      aid: "8662",
      app_name: "novelread",
      version_code: "71332",
      version_name: "7.1.3.32",
      device_platform: "android",
      os: "android",
      ssmix: "a",
      device_type: "25053RT47C",
      device_brand: "Redmi",
      language: "zh",
      os_api: "36",
      os_version: "16",
      manifest_version_code: "71332",
      resolution: "1280*2772",
      dpi: "520",
      update_version_code: "71332",
      host_abi: "arm64-v8a",
      dragon_device_type: "phone",
      pv_player: "71332",
      compliance_status: "0",
      need_personal_recommend: "1",
      player_so_load: "1",
      is_android_pad_screen: "0"
    };
    var PLAYBACK_DEVICE = {
      ...DEVICE,
      version_code: "74332",
      version_name: "7.4.3.32",
      manifest_version_code: "74332",
      update_version_code: "74332",
      pv_player: "74332"
    };
    var PLAYBACK_UA = VIDEO_UA.replace(DEVICE.version_code, PLAYBACK_DEVICE.version_code);
    function str(value, fallback = "") {
      return String(value == null ? fallback : value).trim();
    }
    function cleanUrl(value) {
      return str(value).replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
    }
    function jsonBody(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    function pythonUrlEncode(values) {
      return Object.entries(values).map(([key, value]) => {
        const encode = (item) => encodeURIComponent(String(item == null ? "" : item)).replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
        return `${encode(key)}=${encode(value)}`;
      }).join("&");
    }
    function md5(value) {
      return crypto2.createHash("md5").update(value).digest("hex").toUpperCase();
    }
    function preserveLargeJsonIntegers(raw, fields) {
      const names = fields.map((field) => String(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const pattern = new RegExp(`("(?:${names})"\\s*:\\s*)(-?\\d{16,})(?=\\s*[,}\\]])`, "g");
      return raw.replace(pattern, '$1"$2"');
    }
    function u32(value) {
      return Number(value) >>> 0;
    }
    function rol32(value, count) {
      const n = count & 31;
      const x = u32(value);
      return u32(x << n | x >>> 32 - n);
    }
    function ror32(value, count) {
      const n = count & 31;
      const x = u32(value);
      return u32(x >>> n | x << 32 - n);
    }
    function ror64(value, count) {
      const n = BigInt(count) & 63n;
      const x = BigInt.asUintN(64, BigInt(value));
      return BigInt.asUintN(64, x >> n | x << 64n - n);
    }
    function le32(value) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(u32(value));
      return b;
    }
    function be32(value) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(u32(value));
      return b;
    }
    function zigzag(value) {
      const n = BigInt(value);
      return n < 0n ? -n * 2n - 1n : n * 2n;
    }
    function varint(value) {
      let n = BigInt(value);
      const out = [];
      while (n > 127n) {
        out.push(Number(n & 127n | 128n));
        n >>= 7n;
      }
      out.push(Number(n));
      return Buffer.from(out);
    }
    function protoField(tag, value, type = "string") {
      if (value === void 0 || value === null || value === "") return Buffer.alloc(0);
      if (type === "bytes" || type === "string" || type === "message") {
        const body = type === "bytes" ? Buffer.from(value) : type === "message" ? value : Buffer.from(String(value));
        return Buffer.concat([varint(BigInt(tag) << 3n | 2n), varint(body.length), body]);
      }
      if (type === "float") {
        const body = Buffer.alloc(4);
        body.writeFloatLE(Number(value));
        return Buffer.concat([varint(BigInt(tag) << 3n | 5n), body]);
      }
      return Buffer.concat([varint(BigInt(tag) << 3n), varint(type === "sint" ? zigzag(value) : value)]);
    }
    function proto(fields) {
      return Buffer.concat(fields.map(([tag, value, type]) => protoField(tag, value, type)));
    }
    function getIv(iv, data) {
      let value = u32(iv);
      for (let i = 0; i < data.length; i += 1) {
        if ((i & 1) === 0) value = u32(value >>> 4 ^ value ^ value << 6 ^ data[i]);
        else value = u32(~(value >>> 7 ^ value ^ (data[i] | value << 12)));
      }
      return value;
    }
    function sumMd5(data) {
      let check = 539100192;
      for (let i = 0; i < 12; i += 1) {
        const temp = (i & 1) === 0 ? check >>> 3 ^ check : check >>> 5 ^ check;
        check = (i & 1) === 0 ? data[i] ^ check << 7 : data[i] | check << 11;
        if ((i & 1) !== 0) check = ~check;
        check = u32(check ^ temp);
      }
      return u32((check | 4) ^ 16777216);
    }
    var BRANCH2_SV = [2813263392, 1900671446, 1206176263, 3920990055, 2478384350, 3323252981, 951050479, 2998644083, 3796124867, 2637884571, 3749394404, 3635506496, 4172034488, 1991878923, 836252654, 2503986788, 892704164, 1175044411, 915558408, 2355956005, 1576386935, 486274347, 2320476144, 290235230, 2173958532, 2054850355, 829076693, 1008783305, 2799191123, 974671884, 2039399546, 2544331560, 1724186518, 1366385731, 231930939, 3043585447, 3152755397, 1548997124, 3542485198, 1920580076, 4095250127, 4158100443, 858571921, 2876681749, 2615928615, 413143940, 1542060199, 1603315540, 968254400, 912735363, 2090005780, 2642253015, 3806910890, 1602133673, 2059224401, 1453196762, 1084380722, 1039509925, 3132325248, 1161987804, 1063079544, 64468829, 2986232567, 2779457187];
    var BRANCH2_ORDERS = Buffer.from("0f0704000908030a060b050d0e010c020f05080c0009020103070e060b0a0d04060500070c000a04080f010b0d09020e060b02050403080101070a000d0c090e0d070e0f0b0208030c0509010004060a0d0902060f0b0a040807000c0503010e0c090f07060f030e020d0405010b0a000c050a090e0802040407030f01060b000b0f0408020a0700090d06010e03050c0b060a0508020c03070f0e090d0001040906080f050800040a0b030d01020c0e090d0c0604070a03030f00080105020e01000d0f090a0b0e0402080703060c0501080a0c0f0905060b000304020e070d04080f000c0f0e0d0a01060207090503040205080d0b0a0606000e0f070c09030a08040f000b01060d0c0709030e05020a070b050f00020e0108030d0c0609040d070f08050f06040b0a0e0c090002030d0c020704010b0e0e08060f09050003", "hex");
    function md5V3Step(kind, a, b, c, d, m, shift, constant) {
      let f;
      if (kind === 0) f = b & c | ~b & d;
      else if (kind === 1) f = b & d | c & ~d;
      else if (kind === 2) f = b ^ c ^ d;
      else f = c ^ (b | ~d);
      return u32(b + rol32(u32(a + f + m + constant), shift));
    }
    function md5SumV3(message, countV2, orders, countV1) {
      const sv = BRANCH2_SV.map((value) => ror32(value, countV1));
      const start = [ror32(2044785403, countV2), ror32(3367314800, countV2), ror32(3955423437, countV2), ror32(2081443219, countV2)];
      const endCount = countV2 + 6 & 255;
      const end = [ror32(431900774, endCount), ror32(3898181300, endCount), ror32(3785044590, endCount), ror32(1909577684, endCount)];
      const m = [];
      for (let i = 0; i < 16; i += 1) m.push(message.readUInt32LE(i * 4));
      let [a, b, c, d] = start;
      const run = (kind, order, shifts, offset) => {
        for (let i = 0; i < 16; i += 1) {
          const phase = i & 3;
          const next = phase === 0 ? md5V3Step(kind, a, b, c, d, m[orders[offset + i]], shifts[i], sv[offset + i]) : phase === 1 ? md5V3Step(kind, d, a, b, c, m[orders[offset + i]], shifts[i], sv[offset + i]) : phase === 2 ? md5V3Step(kind, c, d, a, b, m[orders[offset + i]], shifts[i], sv[offset + i]) : md5V3Step(kind, b, c, d, a, m[orders[offset + i]], shifts[i], sv[offset + i]);
          if (phase === 0) a = next;
          else if (phase === 1) d = next;
          else if (phase === 2) c = next;
          else b = next;
        }
      };
      run(0, orders, [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22], 0);
      run(1, orders, [5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20], 16);
      run(2, orders, [4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23], 32);
      run(3, orders, [6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21], 48);
      const ret = Buffer.alloc(16);
      ret.writeUInt32LE(u32(start[0] + a ^ end[0]), 0);
      ret.writeUInt32LE(u32(start[1] + b ^ end[1]), 4);
      ret.writeUInt32LE(u32(start[2] + c ^ end[2]), 8);
      ret.writeUInt32LE(u32(start[3] + d ^ end[3]), 12);
      return Buffer.concat([ret, le32(sumMd5(ret))]);
    }
    function branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos) {
      const v = (iv & 13) * 86;
      const ivV0 = (v >>> 15 & 255) + (v >>> 8 & 255);
      const n1 = [2306929307, 3948190847, 2961647323, 3557602790, 3908393444][ivV0];
      const countV1 = n1 + khronos + 1 & 255;
      const countV2 = u32(n1 + khronos);
      const shift = countV2 + 5 & 7;
      const seed = [132, 150, 119, 157, 212, 21, 11, 248];
      const pad = Buffer.from(seed.map((value) => (value | value << 8) >> shift & 255));
      const input = Buffer.concat([querySm3, bodyMd5, tsBytes, pad, Buffer.from("a0010000", "hex")]);
      return md5SumV3(input, countV2, BRANCH2_ORDERS.subarray(ivV0 << 6, ivV0 + 1 << 6), countV1);
    }
    function bxor(a, b) {
      const out = Buffer.alloc(Math.min(a.length, b.length));
      for (let i = 0; i < out.length; i += 1) out[i] = a[i] ^ b[i];
      return out;
    }
    function hashF13(querySm3, bodyMd5, tsBytes, khronos) {
      const iv = getIv(getIv(getIv(539167016, querySm3), bodyMd5), tsBytes);
      const low = iv & 15;
      const ivV0 = low * 171 >> 9;
      const branch = low - ivV0 * 3;
      if (branch === 2) return branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos);
      if (branch !== 0) return Buffer.concat([querySm3.subarray(0, 16), bodyMd5, le32(sumMd5(Buffer.concat([querySm3, bodyMd5])))]);
      const ivV1List = [3299313024, 3015769401, 3314308742, 3383376807, 4121406962, 2520526545];
      const ivV1 = ivV1List[ivV0];
      const countV1 = ivV1 + khronos + 1 & 255;
      const countV2 = u32(ivV1 + khronos);
      const tt02 = [3954593711, 128638146, 3476129727, 3759225087, 1829502207, 1513137086, 3021657656, 873991864, 4063488879, 2980414668, 3435335111, 1204935505, 3579204574, 1890078625, 1464286226, 4151247496, 738688778, 3658336976, 4223168364, 4257533696, 1753874957, 3866543782, 2362848139, 440175886, 3437801579, 1792077067, 2689738519, 3698437251, 579197809, 3585400230, 1936688720, 1700802668, 1635574438, 3827515774, 172024131, 1414414386, 2296380202, 1902910176, 1279687304, 95566771, 3788552294, 3131301048, 2922607827, 3275233872, 386070363, 4268598120, 4038381384, 1309670328, 1923797261, 650459709, 4072464630, 3025499521, 1243971549, 2352054946, 2869640070, 1029569300, 1326462516, 3548074711, 1146027798, 3943314385, 1822977902, 2640807, 137919738, 1605596550];
      const tt = tt02.map((value) => ror32(value, countV1));
      const n0 = countV2 + 2 & 7;
      const seed = [250, 69, 97, 215];
      const pad = Buffer.from(seed.map((value) => (value | value << 8) >> n0 & 255));
      const data = Buffer.concat([querySm3, bodyMd5, tsBytes, pad, Buffer.from("00000000000001a0", "hex")]);
      const di = [];
      for (let i = 0; i < data.length; i += 4) di.push(data.readUInt32BE(i));
      let di0 = di[0];
      for (let i = 0; i < 112; i += 1) {
        const di1 = di[i + 1];
        const di14 = di[i + 14];
        const r1 = rol32(di1, 14) ^ rol32(di1, 25) ^ di1 >>> 3;
        const r2 = rol32(di14, 13) ^ rol32(di14, 15) ^ di14 >>> 10;
        di.push(u32(di0 + di[i + 9] + r1 + r2));
        di0 = di1;
      }
      const init = [2059030472, 1729520903, 1677982208, 873419055, 984304912, 3005047866, 2874125293, 2152413264].map((v) => ror32(v, countV2 & 31));
      const chosen = [[101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3], [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4], [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5], [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6], [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4], [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5]][ivV0];
      let d = init.slice();
      for (let i = 0; i < chosen[0]; i += 1) {
        const base = ivV1 + i;
        const n0v = di[base & 127];
        const n1 = (d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]] ^ d[chosen[3]];
        const n2 = rol32(d[chosen[1]], 26) ^ rol32(d[chosen[1]], 21) ^ rol32(d[chosen[1]], 7);
        const n4 = u32(n0v + n1 + n2 + tt[base & 63] + d[chosen[5]]);
        const n5 = rol32(d[chosen[2]], 30) ^ rol32(d[chosen[2]], 19) ^ rol32(d[chosen[2]], 10);
        const n6 = d[chosen[2]] & d[chosen[6]] | (d[chosen[2]] | d[chosen[6]]) & d[chosen[7]];
        const n7 = u32(n5 + n6);
        const old = d[chosen[9]];
        d.unshift(d.pop());
        d[chosen[10]] = u32(n7 + n4);
        d[chosen[8]] = u32(old + n4);
      }
      const ret = Buffer.alloc(32);
      for (let i = 0; i < 8; i += 1) ret.writeUInt32BE(u32(d[i] + init[i]), i * 4);
      const folded = bxor(ret.subarray(0, 16), ret.subarray(16));
      folded.copy(ret, 0);
      return Buffer.concat([ret.subarray(0, 16), le32(sumMd5(ret.subarray(0, 16)))]);
    }
    function reverseBits(value) {
      let result = 0;
      for (let i = 0; i < 8; i += 1) result = result << 1 | value >> i & 1;
      return result;
    }
    function rc4Gorgon(data, key) {
      const s = Array.from({ length: 256 }, (_v, i2) => i2);
      let j = 0;
      for (let i2 = 0; i2 < 256; i2 += 1) {
        j = j + s[i2] + key[i2 % key.length] & 255;
        s[i2] = s[j];
      }
      let i = 0;
      j = 0;
      return Buffer.from(data.map((value) => {
        i += 1;
        const x = s[i];
        j += x;
        const y = s[j & 255];
        s[i] = y;
        return value ^ s[y + y & 255];
      }));
    }
    function xGorgon(query, body, timestamp, random) {
      const sdk = Buffer.alloc(4);
      sdk.writeUInt32LE(67503104);
      const input = Buffer.concat([crypto2.createHash("md5").update(query).digest().subarray(0, 4), body ? crypto2.createHash("md5").update(body).digest().subarray(0, 4) : Buffer.alloc(4), Buffer.alloc(4), sdk, be32(timestamp)]);
      const key = [74, 64, 22, random >> 8 & 255, 71, 108, 1, random & 255];
      const out = rc4Gorgon([...input], key);
      for (let i = 0; i < out.length; i += 1) {
        let value = out[i];
        value = (value >> 4 | value << 4) & 255;
        const next = i + 1 < out.length ? out[i + 1] : out[0];
        out[i] = ~(reverseBits((next ^ value) & 255) ^ 20) & 255;
      }
      return Buffer.concat([Buffer.from("8404", "hex"), Buffer.from([random & 255, random >> 8 & 255, 64, 1]), out]).toString("hex");
    }
    function deviceProto(deviceId) {
      return proto([[1, 1, "sint"], [2, 2, "sint"], [3, "8662"], [4, deviceId], [5, PROCESS_NONCE], [6, "!noperm!"], [7, -888888, "sint"], [8, -888888, "sint"], [9, 3, "sint"], [10, -888888, "sint"], [11, "!notset!"], [12, "Asia/Shanghai,8"], [13, "zh_CN"], [14, 4, "sint"], [16, 0, "float"], [17, 0, "float"], [18, 0, "float"], [19, 0, "float"], [20, 0, "float"], [21, 0, "float"], [22, "16"], [23, 41, "sint"], [24, 36, "sint"], [25, PROCESS_STARTED, "sint"], [26, PROCESS_STARTED, "sint"], [27, PROCESS_STARTED, "sint"], [28, PROCESS_STARTED, "sint"], [29, -1, "sint"], [30, "25053RT47C"], [31, "Redmi"], [32, "25053RT47C"], [33, "25053RT47C"], [34, "Xiaomi"], [35, "Redmi"], [36, "Redmi"], [38, 31, "sint"]]);
    }
    var SBOX = Buffer.from("+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==", "base64");
    function xorBytes(a, b) {
      const out = Buffer.from(a);
      for (let i = 0; i < out.length; i += 1) out[i] ^= b[i % b.length];
      return out;
    }
    function matrix(bytes) {
      return Array.from({ length: 4 }, (_v, i) => Array.from(bytes.subarray(i * 4, i * 4 + 4)));
    }
    function flat(rows) {
      return Buffer.from(rows.flat());
    }
    function aesMix(rows) {
      for (let i = 0; i < 4; i += 1) {
        const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i];
        const u = rows[0][i];
        const xt = (x) => (x << 1 ^ (x & 128 ? 27 : 0)) & 255;
        rows[0][i] ^= t ^ xt(rows[0][i] ^ rows[1][i]);
        rows[1][i] ^= t ^ xt(rows[1][i] ^ rows[2][i]);
        rows[2][i] ^= t ^ xt(rows[2][i] ^ rows[3][i]);
        rows[3][i] ^= t ^ xt(rows[3][i] ^ u);
      }
    }
    var AesV3 = class {
      constructor(key, khronos) {
        this.wordSize = khronos & 3;
        this.box = SBOX.subarray(this.wordSize * 256, (this.wordSize + 1) * 256);
        this.con = [[1, 0, 2, 3], [1, 3, 0, 2], [0, 1, 3, 2], [1, 0, 2, 3]][this.wordSize];
        this.con2 = [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]][this.wordSize];
        this.order = [[0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3], [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11], [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15], [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3]][this.wordSize];
        const init = [3389152732, 2185086278, 3376547203, 3264750175][this.wordSize];
        const initial = Buffer.alloc(16);
        for (let i = 0; i < 4; i += 1) initial.writeUInt32LE(init, i * 4);
        const mk = xorBytes(initial, key);
        const expanded = Buffer.concat([mk, Buffer.alloc(32)]);
        let rounds = 8;
        for (let i = 4; i < 12; i += 1) {
          let at = 4 * (i - 1);
          let a = expanded[at], b = expanded[at + 1], c = expanded[at + 2], d = expanded[at + 3];
          if ((i & 3) === 0) {
            const t = (u32(init >> (rounds & 24)) ^ this.box[b]) & 255;
            b = this.box[c];
            c = this.box[d];
            d = this.box[a];
            a = t;
          }
          rounds += 2;
          expanded[at + 4] = a ^ expanded[at - 12];
          expanded[at + 5] = b ^ expanded[at - 11];
          expanded[at + 6] = c ^ expanded[at - 10];
          expanded[at + 7] = d ^ expanded[at - 9];
        }
        this.keys = Array.from({ length: 12 }, (_v, i) => Array.from(expanded.subarray(i * 4, i * 4 + 4)));
      }
      add(rows, key) {
        for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) rows[i][j] ^= key[i][j];
      }
      addCon(rows, keys) {
        for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) rows[i][j] ^= keys[i][this.con2[j]];
      }
      sub(rows) {
        for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) rows[i][j] = this.box[rows[i][j]];
        const old = rows.map((x) => x.slice());
        for (let i = 0; i < 4; i += 1) rows[i] = old[this.con2[i]];
      }
      shift(rows) {
        const b = flat(rows);
        for (let i = 0; i < 16; i += 1) rows[Math.floor(i / 4)][i % 4] = b[this.order[i]];
      }
      shiftCon(rows) {
        const old = rows.map((x) => x.slice());
        for (let i = 0; i < 4; i += 1) rows[i] = this.con2.map((x) => old[i][x]);
      }
      block(value) {
        const rows = matrix(value);
        this.addCon(rows, this.keys.slice(0, 4));
        for (let i = 1; i < 3; i += 1) {
          this.sub(rows);
          this.shift(rows);
          if (i === 1) {
            this.shiftCon(rows);
            aesMix(rows);
          }
          this.addCon(rows, this.keys.slice(i * 4));
        }
        this.add(rows, this.keys.slice(4));
        return flat(rows);
      }
      encrypt(data, iv) {
        const source = Buffer.from(data);
        const plaintext = Buffer.alloc(32);
        for (let i = 0; i < 31; i += 1) {
          const at = i * 8;
          const n0 = source[at] >> 4 & 2;
          const n1 = n0 | source[at + 1] & 64;
          const n2 = n1 | source[at + 2] >> 2 & 1;
          const n3 = n2 | source[at + 3] << 3 & 128;
          const n4 = n3 | source[at + 4] >> 1 & 4;
          const n5 = n4 | source[at + 5] << 3 & 16;
          const n6 = n5 | source[at + 6] << 5 & 32;
          plaintext[i] = n6 | source[at + 7] >> 4 & 8;
        }
        plaintext[31] = 1;
        const blocks = [];
        let previous = Buffer.from(iv);
        for (let i = 0; i < plaintext.length; i += 16) {
          const value = this.block(xorBytes(plaintext.subarray(i, i + 16), previous));
          blocks.push(value);
          previous = value;
        }
        const key = Buffer.concat(blocks);
        const out = Buffer.from(source);
        for (let i = 0; i < 31; i += 1) {
          const at = i * 8;
          const k = key[i];
          out[at] &= 223;
          out[at] |= k << 4 & 32;
          out[at + 1] &= 191;
          out[at + 1] |= k & 64;
          out[at + 2] &= 251;
          out[at + 2] |= k << 2 & 4;
          out[at + 3] &= 239;
          out[at + 3] |= k >> 3 & 16;
          out[at + 4] &= 247;
          out[at + 4] |= k + k & 8;
          out[at + 5] &= 253;
          out[at + 5] |= k >> 3 & 2;
          out[at + 6] &= 254;
          out[at + 6] |= k >> 5 & 1;
          out[at + 7] &= 127;
          out[at + 7] |= k << 4 & 128;
        }
        return Buffer.concat([key.subarray(-1), out]);
      }
    };
    function xmxor(data, key) {
      const encoded = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i += 1) {
        const at = i * 4 & 28;
        const d0 = key[at], d1 = key[at + 1];
        let d2 = ((data[i] << 4 | data[i] >>> 4) & 255) + d0;
        d2 = ~d2 ^ d1;
        d2 = ((d2 & 255) << 3 | (d2 & 255) >>> 5) & 255;
        d2 = d2 + d1 & 255;
        d2 = (d2 ^ d0) & 255;
        encoded[data.length - i - 1] = ~d2 & 255;
      }
      let last = encoded[encoded.length - 1] ^ encoded[encoded.length - 2];
      const first = encoded[0];
      encoded[0] = ~last + first & 255;
      encoded[1] = (encoded[0] ^ encoded[encoded.length - 1] ^ 254) + encoded[1] & 255;
      encoded[2] = encoded[2] + (last - first ^ (encoded[1] << 3 | encoded[1] >>> 5) & 255 ^ 2) & 255;
      for (let i = 0; i < encoded.length - 4; i += 1) {
        const temp = (encoded[i + 2] << 3 | encoded[i + 2] >>> 5) & 255 ^ encoded[i + 1] ^ i + 3;
        encoded[i + 3] = ~temp + encoded[i + 3] & 255;
      }
      encoded[encoded.length - 1] ^= encoded[encoded.length - 2];
      let sum = 0;
      for (let i = 0; i < encoded.length - 1; i += 1) sum += encoded[i + 1];
      encoded[0] = (encoded[0] ^ encoded[1]) + sum & 255;
      return encoded;
    }
    function keyHash(signKey, random) {
      const input = Buffer.concat([signKey, le32(random), signKey]);
      const hash = sm3(input);
      const d1 = random >> 16 & 255;
      let d2 = (d1 << 11 | random >>> 24) ^ d1 >> 5 ^ d1;
      d2 = ~d2 >>> 0;
      return [hash, le32(d2)];
    }
    function buildMedusa(url, body, khronos, device) {
      const bodyMd5 = body ? crypto2.createHash("md5").update(body).digest() : Buffer.alloc(16);
      const querySm3 = sm3(url.split("?")[1]);
      const ts = le32(khronos);
      const queryBodyTs = hashF13(querySm3, bodyMd5, ts, khronos);
      const nested = proto([[1, 111, "sint"], [2, 10, "sint"], [3, 694367, "sint"], [5, 586952199, "sint"]]);
      const messageRand = Math.floor(Math.random() * 4294967296);
      const envLaunch = Math.floor(Math.random() * 21) + 100;
      const envPid = Math.floor(Math.random() * 2e3) + 10001;
      const env = proto([[1, envLaunch, "sint"], [2, 146331399, "sint"], [3, 146331396, "sint"], [5, 7, "sint"], [6, "v04.06.04.03-bugfix"], [7, envPid, "sint"], [12, deviceProto(device.device_id), "message"], [13, proto([[1, Math.floor(Date.now() / 1e3), "sint"], [2, -2, "sint"], [4, 200, "sint"]]), "message"], [14, device.version_name]]);
      const queryHash = sm3(Buffer.concat([Buffer.from(url.split("?")[1]), bodyMd5, Buffer.from("none")]));
      const message = proto([[1, Buffer.from("f7e85ffad7d7dc3bd62ac87057cf6118", "hex"), "bytes"], [2, 3, "sint"], [3, messageRand, "sint"], [4, "8662"], [5, device.device_id], [6, "1588093228"], [7, device.version_name], [8, "v04.06.04-ml-android"], [9, 67503104, "sint"], [10, Buffer.from("4001000000000000", "hex"), "bytes"], [12, khronos, "sint"], [13, queryBodyTs, "bytes"], [14, querySm3.subarray(0, 6), "bytes"], [15, nested, "message"], [16, PROCESS_NONCE], [17, khronos, "sint"], [19, queryHash, "bytes"], [20, "none"], [21, 312, "sint"], [23, env, "message"], [24, '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}']]);
      const random = Math.floor(Math.random() * 4294967296);
      const [hash, seed] = keyHash(Buffer.from("8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eae f71cb691f7aa8aa2f5".replace(/ /g, ""), "hex"), random);
      let transformed = xmxor(message, hash);
      transformed = Buffer.concat([Buffer.from("4001000000000000", "hex"), transformed]).reverse();
      for (let i = 0; i < transformed.length; i += 1) transformed[i] ^= seed[~i & 3];
      const check = (querySm3[0] & 63) << 14 | 402653185 | (queryBodyTs[0] & 63) << 8;
      const xmRand = Math.floor(Math.random() * 4294967296);
      const packed = Buffer.concat([Buffer.from([53]), le32(xmRand), le32(check), transformed, Buffer.from([random >> 16, random >> 24])]);
      const encrypted = new AesV3(Buffer.from("f1593376766ea98d34f31b057a9d5be4", "hex"), khronos).encrypt(packed, Buffer.from("1fe109a4125283f418de9e051a969e12", "hex"));
      const version = Buffer.from("03000000f7e85ffad7d7dc3bd62ac87057cf6118", "hex");
      const prefix = Buffer.alloc(20);
      for (let i = 0; i < 20; i += 4) prefix.writeUInt32LE(u32(version.readUInt32LE(i) ^ khronos), i);
      return Buffer.concat([prefix, Buffer.from([random & 255, random >> 8 & 255, 0, 1]), encrypted]).toString("base64");
    }
    function helios(khronos) {
      const random = Math.floor(Math.random() * 4294967296);
      const data = Buffer.concat([le32(random), Buffer.from("8662")]);
      const digest = crypto2.createHash("md5").update(data).digest();
      const ascii = Buffer.from(digest.toString("hex"), "ascii");
      const words = [];
      for (let i = 0; i < 4; i += 1) words.push(ascii.readBigUInt64LE(i * 8));
      const table = [words[0]];
      let b0 = words[0];
      let b8 = words[1];
      words.splice(0, 2);
      for (let i = 0; i < 34; i += 1) {
        let x8 = BigInt.asUintN(64, ror64(b8, 8) + b0);
        x8 = BigInt.asUintN(64, x8 ^ BigInt(i));
        words.push(x8);
        x8 = BigInt.asUintN(64, x8 ^ ror64(b0, 61));
        table.push(x8);
        b0 = x8;
        b8 = words.shift();
      }
      const text = Buffer.from(`${khronos}-1588093228-8662`);
      const pad = Buffer.alloc(Math.ceil((text.length + 1) / 16) * 16, 16 - text.length % 16);
      text.copy(pad);
      const output = [];
      for (let at = 0; at < pad.length; at += 16) {
        let a = pad.readBigUInt64LE(at);
        let b = pad.readBigUInt64LE(at + 8);
        for (let i = 0; i < 34; i += 1) {
          b = BigInt.asUintN(64, table[i] ^ a + ror64(b, 8));
          a = BigInt.asUintN(64, b ^ ror64(a, 61));
        }
        const block = Buffer.alloc(16);
        block.writeBigUInt64LE(a);
        block.writeBigUInt64LE(b, 8);
        output.push(block);
      }
      return Buffer.concat([le32(random), ...output]).toString("base64");
    }
    function branchOf(url, body, khronos) {
      const bodyMd5 = body ? crypto2.createHash("md5").update(body).digest() : Buffer.alloc(16);
      const q = sm3(url.split("?")[1]);
      const iv = getIv(getIv(getIv(539167016, q), bodyMd5), le32(khronos));
      const low = iv & 15;
      return low - (low * 171 >> 9) * 3;
    }
    function playbackRequest(payload, identity, videoId = "", alternate = false) {
      if (videoId) {
        const body2 = gzipSync(Buffer.from(payload));
        const signed = signPlaybackV5({
          base: alternate ? PLAYER_API.replace("sinfonlineb.", "sinfonlinea.") : PLAYER_API,
          values: {
            aid: "8662",
            app_name: "novelread",
            version_code: "74332",
            version_name: "7.4.3.32",
            channel: "vivo_8662_64",
            device_platform: "android",
            device_type: "PGT-AN10",
            os_version: "12",
            update_version_code: "74332",
            iid: identity.iid,
            cdid: identity.cdid,
            device_id: identity.device_id
          },
          body: body2,
          now: Date.now()
        });
        return { ...signed, body: body2, method: "POST", headers: {
          ...signed.headers,
          "User-Agent": "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)",
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip"
        } };
      }
      const body = gzipSync(Buffer.from(payload));
      const requestTicket = Date.now(), khronos = Math.floor(requestTicket / 1e3);
      const device = { ...PLAYBACK_DEVICE, ...identity };
      const query = pythonUrlEncode({ ...device, ts: String(khronos), _rticket: String(requestTicket) });
      const api = VIDEO_API;
      const url = `${api}?${query}`;
      const signature = signPlayer({ query, body, ts: khronos });
      const headers = {
        "User-Agent": VIDEO_UA.replace(DEVICE.version_code, device.version_code),
        Accept: "application/json; charset=utf-8,application/x-protobuf",
        "x-ss-req-ticket": signature["x-ss-req-ticket"],
        "sdk-version": "2",
        "x-xs-from-web": "0",
        "passport-sdk-version": "5051452",
        "x-ss-dp": String(device.aid),
        "x-khronos": signature["x-khronos"],
        "x-ladon": signature["x-ladon"],
        "x-argus": signature["x-argus"],
        "x-tt-dt": "",
        "x-tt-store-region": "cn",
        "x-tt-store-region-src": "did"
      };
      Object.assign(headers, {
        "Content-Type": "application/json; charset=UTF-8",
        "Content-Encoding": "gzip",
        "x-ss-stub": signature["x-ss-stub"]
      });
      return { url, body, headers, method: "POST" };
    }
    function parseSearchInteger(value) {
      if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return null;
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 0 ? number : null;
    }
    function signedSearchRequest({ keyword, page = 1, cursor = null, identity } = {}) {
      const pg = parseSearchInteger(page);
      if (pg === null || pg < 1 || pg > 50) throw Object.assign(new Error("App \u641C\u7D22\u9875\u7801\u9700\u4E3A 1 \u81F3 50 \u7684\u6574\u6570"), { code: "APP_INPUT" });
      if (![identity?.device_id, identity?.iid].every((value) => typeof value === "string" && /^\d{1,30}$/.test(value) && /[1-9]/.test(value)) || typeof identity?.cdid !== "string" || !/^[a-f0-9-]{36}$/i.test(identity.cdid)) {
        throw Object.assign(new Error("App \u641C\u7D22\u8BBE\u5907\u8EAB\u4EFD\u65E0\u6548"), { code: "APP_INPUT" });
      }
      const device = {
        ...DEVICE,
        version_code: "72232",
        version_name: "7.2.2.32",
        manifest_version_code: "72232",
        update_version_code: "72232",
        pv_player: "72232",
        iid: identity.iid,
        device_id: identity.device_id,
        cdid: identity.cdid
      };
      const khronos = Math.floor(Date.now() / 1e3), ticketBase = Date.now();
      const base = {
        ...device,
        query: String(keyword || "").slice(0, 80),
        count: "20",
        tab_type: "11",
        bookshelf_search_plan: "4",
        use_correct: "true",
        user_is_login: "0"
      };
      if (cursor?.search_id) base.search_id = cursor.search_id;
      if (cursor?.passback) base.passback = cursor.passback;
      const offset = parseSearchInteger(cursor?.next_offset) ?? (pg - 1) * 20;
      base.offset = String(offset);
      let requestTicket = ticketBase, query = "", url = "";
      for (let n = 0; n < 128; n += 1) {
        requestTicket = ticketBase + n;
        query = pythonUrlEncode({ ...base, ts: String(khronos), _rticket: String(requestTicket) });
        url = `${SEARCH_API}?${query}`;
        if (branchOf(url, null, khronos) === 0) break;
        if (n === 127) throw new Error("\u65E0\u6CD5\u751F\u6210\u641C\u7D22\u8BF7\u6C42\u7B7E\u540D");
      }
      const random = Math.floor(Math.random() * 65536);
      const headers = {
        "User-Agent": SEARCH_UA,
        Accept: "application/json; charset=utf-8,application/x-protobuf",
        "x-ss-req-ticket": String(requestTicket),
        "x-tt-request-tag": "t=0;n=0",
        "sdk-version": "2",
        "passport-sdk-version": "50561",
        "x-xs-from-web": "0",
        "x-khronos": String(khronos),
        "x-ladon": be32(khronos).toString("base64"),
        "x-argus": le32(khronos).toString("base64"),
        "x-gorgon": xGorgon(query, null, khronos, random),
        "x-helios": helios(khronos),
        "x-medusa": buildMedusa(url, null, khronos, device),
        "x-tt-dt": ""
      };
      return { url, headers };
    }
    var metadataDevice = {
      ...DEVICE,
      version_code: "73532",
      version_name: "7.3.5.32",
      manifest_version_code: "73532",
      update_version_code: "73532",
      pv_player: "73532",
      iid: localId(),
      device_id: localId()
    };
    function signedMetadataRequest(apiPath, values = {}, payload = null) {
      if (!["/reading/distribution/category/landpage/v/", "/reading/bookapi/bookmall/cell/change/v"].includes(apiPath)) {
        throw new Error("\u4E0D\u652F\u6301\u7684 App \u76EE\u5F55\u63A5\u53E3");
      }
      const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
      const khronos = Math.floor(Date.now() / 1e3), ticketBase = Date.now();
      let query, url, requestTicket;
      for (let n = 0; n < 128; n += 1) {
        requestTicket = ticketBase + n;
        query = pythonUrlEncode({ ...values, ...metadataDevice, ts: String(khronos), _rticket: String(requestTicket) });
        url = `https://api5-normal-sinfonlineb.fqnovel.com${apiPath}?${query}`;
        if (branchOf(url, body, khronos) === 0) break;
        if (n === 127) throw new Error("\u65E0\u6CD5\u751F\u6210 App \u76EE\u5F55\u8BF7\u6C42\u7B7E\u540D");
      }
      const headers = {
        "User-Agent": VIDEO_UA.replace("71332", "73532"),
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "x-xs-from-web": "0",
        "sdk-version": "2",
        "x-ss-dp": "8662",
        "x-tt-store-region": "cn",
        "x-tt-store-region-src": "did",
        "x-ss-req-ticket": String(requestTicket),
        "x-khronos": String(khronos),
        "x-gorgon": xGorgon(query, body, khronos, Math.floor(Math.random() * 65536)),
        "x-ladon": be32(khronos).toString("base64"),
        "x-argus": le32(khronos).toString("base64"),
        "x-helios": helios(khronos),
        "x-medusa": buildMedusa(url, body, khronos, metadataDevice),
        "x-tt-dt": ""
      };
      if (body) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        headers["x-ss-stub"] = md5(body);
      }
      return { url, headers, body };
    }
    function signedAccountRequest(apiPath, values = {}, identity) {
      if (!["/reading/user/info/v1/", "/reading/bookapi/read_history/list/v1/", "/reading/bookapi/read_progress/list/v1/", "/reading/bookapi/multi-detail/v1/"].includes(apiPath)) {
        throw new Error("\u4E0D\u652F\u6301\u7684\u8D26\u53F7\u63A5\u53E3");
      }
      if (![identity?.device_id, identity?.iid].every((value) => typeof value === "string" && /^\d{1,30}$/.test(value) && /[1-9]/.test(value)) || typeof identity?.cdid !== "string" || !/^[a-f0-9-]{36}$/i.test(identity.cdid)) {
        throw new Error("\u8D26\u53F7\u8BBE\u5907\u8EAB\u4EFD\u65E0\u6548");
      }
      const device = {
        ...DEVICE,
        version_code: "72232",
        version_name: "7.2.2.32",
        manifest_version_code: "72232",
        update_version_code: "72232",
        pv_player: "72232",
        iid: identity.iid,
        device_id: identity.device_id,
        cdid: identity.cdid
      };
      const khronos = Math.floor(Date.now() / 1e3), ticketBase = Date.now();
      let query, url, requestTicket;
      for (let n = 0; n < 128; n += 1) {
        requestTicket = ticketBase + n;
        query = pythonUrlEncode({ ...values, ...device, ts: String(khronos), _rticket: String(requestTicket) });
        url = `https://api5-normal-sinfonlinea.fqnovel.com${apiPath}?${query}`;
        if (branchOf(url, null, khronos) === 0) break;
        if (n === 127) throw new Error("\u65E0\u6CD5\u751F\u6210\u8D26\u53F7\u8BF7\u6C42\u7B7E\u540D");
      }
      const headers = {
        "User-Agent": SEARCH_UA,
        Accept: "application/json; charset=utf-8,application/x-protobuf",
        "x-ss-req-ticket": String(requestTicket),
        "x-tt-request-tag": "t=0;n=0",
        "sdk-version": "2",
        "passport-sdk-version": "50561",
        "x-xs-from-web": "0",
        "x-khronos": String(khronos),
        "x-ladon": be32(khronos).toString("base64"),
        "x-argus": le32(khronos).toString("base64"),
        "x-gorgon": xGorgon(query, null, khronos, Math.floor(Math.random() * 65536)),
        "x-helios": helios(khronos),
        "x-medusa": buildMedusa(url, null, khronos, device),
        "x-tt-dt": ""
      };
      return { url, headers };
    }
    function parseFallback(value) {
      if (typeof value === "string") {
        const parsed = jsonBody(value);
        return parsed?.fallback_api || value;
      }
      if (Array.isArray(value)) return str(value[0]);
      return str(value?.fallback_api);
    }
    function deriveContentKey(value) {
      const raw = Buffer.from(str(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (raw.length < 3) throw new Error("spade_a too short");
      let v8 = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
      v8 = Math.min(v8, raw.length - 1);
      if (v8 < 33) throw new Error("spade_a key length invalid");
      const work = Buffer.from(raw.subarray(1, 1 + v8));
      let a = 85;
      let b = 246;
      for (let i = 0; i < v8; i += 1) {
        const old = work[i];
        const previous = i & 1 ? a : b;
        if (i & 1) a = old;
        else b = old;
        const pop = i.toString(2).split("1").length - 1;
        work[i] = -21 - pop + (previous ^ old) & 255;
      }
      const hex = work.subarray(1, 33).toString("ascii");
      if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("App \u89C6\u9891\u5BC6\u94A5\u683C\u5F0F\u65E0\u6548");
      return Buffer.from(hex, "hex");
    }
    function decryptSpadeUrl(value, seed) {
      const encoded = str(value);
      if (!encoded) return "";
      const raw = Buffer.from(encoded, "base64");
      if (raw.length < 5) throw new Error("spade URL ciphertext too short");
      if (raw[0] !== 168 || raw[2] !== 1 || raw[3] !== 0) throw new Error("spade URL header format error");
      const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
      if (!cipherLength) throw new Error("spade URL ciphertext has no complete block");
      const constants = Buffer.from("4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58", "hex");
      const h1 = crypto2.createHash("sha512").update(seed).digest();
      const h2 = crypto2.createHash("sha512").update(Buffer.concat([h1, constants])).digest();
      const decipher = crypto2.createDecipheriv("aes-128-cbc", h2.subarray(0, 16), h2.subarray(16, 32));
      decipher.setAutoPadding(false);
      let plaintext = Buffer.concat([decipher.update(raw.subarray(4, 4 + cipherLength)), decipher.final()]);
      if (plaintext.length) {
        const padding = plaintext[plaintext.length - 1];
        if (padding >= 1 && padding <= 16 && padding <= plaintext.length) plaintext = plaintext.subarray(0, plaintext.length - padding);
      }
      while (plaintext.length && plaintext[plaintext.length - 1] === 0) plaintext = plaintext.subarray(0, plaintext.length - 1);
      return plaintext.toString("utf8");
    }
    function checkedUrl(value, domains) {
      let url;
      try {
        url = new URL(value);
      } catch (_) {
        throw Object.assign(new Error("App \u7247\u6E90\u5730\u5740\u683C\u5F0F\u65E0\u6548"), { code: "INVALID_RESPONSE" });
      }
      if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
        throw Object.assign(new Error("App \u7247\u6E90\u8FD4\u56DE\u4E86\u4E0D\u53D7\u652F\u6301\u7684\u670D\u52A1\u5730\u5740"), { code: "SECURITY_BLOCKED" });
      }
      return url.href;
    }
    async function requestJson(url, options, deadline, signal) {
      const axios2 = require_axios();
      const preserveFields = Array.isArray(options?.preserveLargeIntegerFields) ? options.preserveLargeIntegerFields : null;
      const requestOptions = { ...options };
      delete requestOptions.preserveLargeIntegerFields;
      for (let redirects = 0; redirects < 4; redirects++) {
        throwIfAborted2(signal);
        url = checkedUrl(url, ["fqnovel.com", "snssdk.com"]);
        const timeout = deadline - Date.now();
        if (timeout <= 0) throw Object.assign(new Error("App \u7247\u6E90\u8BF7\u6C42\u8D85\u65F6"), { code: "ETIMEDOUT" });
        let response;
        try {
          response = await axios2({
            ...requestOptions,
            url,
            timeout,
            signal,
            maxRedirects: 0,
            responseType: "text",
            transformResponse: [(data) => data],
            maxContentLength: 2 * 1024 * 1024,
            maxBodyLength: 1024 * 1024,
            validateStatus: () => true
          });
        } catch (error) {
          if (signal?.aborted) throw abortError2(signal);
          if (error?.code === "ERR_CANCELED") throw abortError2();
          const detail = networkFailure(error?.code);
          const code = detail || ["ECONNABORTED", "ETIMEDOUT"].includes(error?.code) ? error.code : "ERR_NETWORK";
          throw Object.assign(new Error(["ECONNABORTED", "ETIMEDOUT"].includes(code) ? "App \u7247\u6E90\u8BF7\u6C42\u8D85\u65F6" : "App \u7247\u6E90\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"), {
            code,
            ...detail && code !== "ECONNABORTED" ? { networkFailure: detail } : {}
          });
        }
        throwIfAborted2(signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const bound = Object.keys(requestOptions.headers || {}).some((name) => /^(?:x-argus|x-ladon|x-gorgon|x-medusa|cookie|authorization)$/i.test(name));
          if (requestOptions.method === "POST" || bound || !response.headers.location) throw Object.assign(new Error("App \u63A5\u53E3\u53D1\u751F\u4E0D\u652F\u6301\u7684\u8DF3\u8F6C"), { code: "SECURITY_BLOCKED" });
          url = checkedUrl(new URL(response.headers.location, url).href, ["fqnovel.com", "snssdk.com"]);
          continue;
        }
        if (response.status !== 200) throw Object.assign(new Error(`App \u7247\u6E90\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`), { status: response.status });
        const raw = typeof response.data === "string" ? response.data : "";
        if (!raw.trim()) {
          throw Object.assign(new Error("App \u63A5\u53E3\u8FD4\u56DE\u7A7A\u54CD\u5E94\uFF08HTTP 200\uFF09\uFF0C\u539F\u56E0\u5C1A\u672A\u786E\u8BA4"), {
            code: "EMPTY_RESPONSE",
            status: response.status
          });
        }
        const normalized = preserveFields?.length ? preserveLargeJsonIntegers(raw, preserveFields) : raw;
        const parsed = typeof response.data === "string" ? jsonBody(normalized) : response.data;
        if (!parsed || typeof parsed !== "object") throw Object.assign(new Error("App \u63A5\u53E3\u672A\u8FD4\u56DE\u6709\u6548\u6570\u636E"), { code: "INVALID_RESPONSE" });
        return parsed;
      }
      throw Object.assign(new Error("App \u7247\u6E90\u8DF3\u8F6C\u6B21\u6570\u8FC7\u591A"), { code: "SECURITY_BLOCKED" });
    }
    async function fetchAppPlayUrl(vid, options = {}) {
      throwIfAborted2(options.signal);
      normalizeDownloadQuality2(options.quality);
      vid = String(vid || "");
      if (!/^\d{1,30}$/.test(vid)) throw new Error("\u5206\u96C6\u7F16\u53F7\u65E0\u6548");
      const previousRejection = playbackRejection;
      const pending = playbackQueue.then(async () => {
        throwIfAborted2(options.signal);
        if (playbackRejection !== previousRejection) throw playbackRejection;
        const wait = playbackReadyAt - Date.now();
        if (wait > 0) {
          try {
            await delay(wait, void 0, { signal: options.signal });
          } catch (error) {
            throwIfAborted2(options.signal);
            throw error;
          }
        }
        throwIfAborted2(options.signal);
        try {
          return await fetchAppPlayUrlFresh(vid, options);
        } catch (error) {
          if ([403, 429].includes(error.status) || error.code === "BUSINESS_REJECTED" || error.code === "DEVICE_REGISTRATION_FAILED" && ["BUSINESS_REJECTED", "HTTP_403", "HTTP_429"].includes(error.registrationFailure)) playbackRejection = error;
          throw error;
        } finally {
          playbackReadyAt = Math.max(playbackReadyAt, Date.now() + 1e3);
        }
      });
      playbackQueue = pending.catch(() => {
      });
      if (!options.signal) return pending;
      let cancel;
      try {
        return await Promise.race([pending, new Promise((resolve, reject) => {
          cancel = () => reject(abortError2(options.signal));
          options.signal.addEventListener("abort", cancel, { once: true });
          if (options.signal.aborted) cancel();
        })]);
      } finally {
        options.signal.removeEventListener("abort", cancel);
      }
    }
    async function fetchAppPlayUrlFresh(vid, options) {
      const payload = JSON.stringify({
        biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, disable_video_relate_book: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
        mixed_video_id_map: { "1004": [vid] },
        dr_scene: "player"
      });
      let identity = await registerPlaybackDevice(requestJson, { signal: options.signal });
      throwIfAborted2(options.signal);
      const deadline = Date.now() + 12e3;
      const request = boundedSignal(options.signal, 12e3);
      const { signal } = request;
      try {
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          throwIfAborted2(signal);
          const signed = playbackRequest(payload, identity, attempt ? "" : vid);
          if (attempt) signed.headers.Connection = "close";
          try {
            try {
              response = await requestJson(signed.url, { method: signed.method, headers: signed.headers, data: signed.body }, deadline, signal);
            } catch (error) {
              throwIfAborted2(signal);
              if (attempt || error.code !== "EMPTY_RESPONSE" || deadline - Date.now() < 1e3) throw error;
              const alternate = playbackRequest(payload, identity, vid, true);
              response = await requestJson(alternate.url, { method: alternate.method, headers: alternate.headers, data: alternate.body }, deadline, signal);
            }
            throwIfAborted2(signal);
            break;
          } catch (error) {
            throwIfAborted2(signal);
            if (error.code === "ERR_CANCELED") throw error;
            if (attempt || error.code !== "EMPTY_RESPONSE" || deadline - Date.now() < 1e3) throw error;
            if (deadline - Date.now() >= 8e3) {
              try {
                identity = await registerPlaybackDevice(requestJson, { signal });
              } catch (registrationError) {
                throwIfAborted2(signal);
                if (registrationError.code === "ERR_CANCELED") throw registrationError;
                if (registrationError.code === "DEVICE_REGISTRATION_FAILED" && ["BUSINESS_REJECTED", "HTTP_403", "HTTP_429"].includes(registrationError.registrationFailure)) throw registrationError;
              }
            }
            throwIfAborted2(signal);
            if (deadline - Date.now() < 1500) throw error;
            try {
              await delay(1e3, void 0, { signal });
            } catch (waitError) {
              throwIfAborted2(signal);
              throw waitError;
            }
            throwIfAborted2(signal);
          }
        }
        if (Number(response.Code || response.code || 0) !== 0) throw Object.assign(new Error("App \u63A5\u53E3\u6682\u672A\u63D0\u4F9B\u672C\u96C6\u64AD\u653E\u4FE1\u606F"), { code: "BUSINESS_REJECTED" });
        const entries = response.data?.["1004"] ?? response.data?.video_model_data ?? response.data;
        const entry = entries?.[vid];
        const model = typeof entry?.video_model === "string" ? jsonBody(entry.video_model) : entry?.video_model;
        if (!model || typeof model !== "object" || Array.isArray(model)) throw Object.assign(new Error("App \u63A5\u53E3\u672A\u8FD4\u56DE\u6240\u9009\u5206\u96C6\uFF0C\u5DF2\u505C\u6B62\u53D6\u5740"), { code: entry?.video_model ? "INVALID_RESPONSE" : "MISSING_MODEL" });
        const inline = model.video_list && typeof model.video_list === "object" && Object.keys(model.video_list).length > 0;
        const readFallback = async () => {
          const fallback = parseFallback(model.fallback_api);
          if (!fallback) throw Object.assign(new Error("App \u63A5\u53E3\u672A\u8FD4\u56DE\u672C\u96C6\u7247\u6E90\u5730\u5740"), { code: "MISSING_MODEL" });
          const outer = await requestJson(fallback, { headers: { "User-Agent": VIDEO_UA } }, deadline, signal);
          throwIfAborted2(signal);
          if ([outer, outer.video_info].some((value) => Number(value?.Code || value?.code || 0) !== 0)) {
            throw Object.assign(new Error("App \u63A5\u53E3\u6682\u672A\u63D0\u4F9B\u672C\u96C6\u64AD\u653E\u4FE1\u606F"), { code: "BUSINESS_REJECTED" });
          }
          return outer?.video_info?.data;
        };
        if (!inline) {
          const info = await readFallback();
          throwIfAborted2(signal);
          return parseAppPlayModel(info, vid, options, false);
        }
        try {
          return parseAppPlayModel(model, vid, options, true);
        } catch (error) {
          const duration = Number(model.video_duration);
          if (!error.incompleteEncryptionMetadata || typeof model.video_id !== "string" || !model.video_id.trim() || !Number.isFinite(duration) || duration <= 0 || !error.minimumPixels || !model.fallback_api) throw error;
          const info = await readFallback();
          throwIfAborted2(signal);
          const fallbackDuration = Number(info?.video_duration);
          if (info?.video_id !== model.video_id || !Number.isFinite(fallbackDuration) || fallbackDuration <= 0 || Math.abs(fallbackDuration - duration) > 0.5) {
            throw Object.assign(new Error("\u5907\u7528\u7247\u6E90\u7F16\u53F7\u6216\u5B8C\u6574\u65F6\u957F\u65E0\u6CD5\u786E\u8BA4\uFF0C\u5DF2\u505C\u6B62\u53D6\u5740"), { code: "INVALID_RESPONSE" });
          }
          return parseAppPlayModel(info, vid, options, false, true, error.minimumPixels);
        }
      } finally {
        request.dispose();
      }
    }
    function parseAppPlayModel(info, vid, options, inline, requireEncryptionMetadata = inline, minimumPixels = 0) {
      const requestedQuality = normalizeDownloadQuality2(options.quality);
      const allowLowerQuality = options.allowLowerQuality === true && requestedQuality !== "auto";
      if (!info) throw Object.assign(new Error("App \u63A5\u53E3\u672A\u8FD4\u56DE\u672C\u96C6\u7247\u6E90\u6A21\u578B"), { code: "MISSING_MODEL" });
      const compatibleRows = Object.values(info?.video_list || {}).filter((item) => item && (item.main_url || item.backup_url || Array.isArray(item.backup_url_list))).map((item) => {
        const codec = str(item.codec_type || item.video_meta?.codec_type).toLowerCase();
        const codecRank = ["h264", "avc", "avc1"].includes(codec) ? 0 : ["hevc", "h265", "hvc1", "hev1", "bytevc1"].includes(codec) ? 1 : codec === "bytevc2" ? 2 : 3;
        const quality = str(item.quality_desc || item.definition || item.video_meta?.definition || item.height || item.vheight);
        const meta = item.video_meta || {};
        const [width, height] = [[item.vwidth, item.vheight], [item.width, item.height], [meta.vwidth, meta.vheight], [meta.width, meta.height]].map((pair) => pair.map(Number)).find((pair) => pair.every((value) => Number.isFinite(value) && value > 0)) || [0, 0];
        const pixels = width && height ? Math.min(width, height) : Number(quality.match(/\d+/)?.[0] || 0);
        return { item, codec, codecRank, quality, pixels, width, height };
      }).filter((row) => row.codecRank < 3 && (!minimumPixels || Math.min(row.width, row.height) >= minimumPixels) && (row.codecRank !== 2 || row.width > 0 && row.height > 0 && typeof info.video_id === "string" && info.video_id.trim() && Number.isFinite(Number(info.video_duration)) && Number(info.video_duration) > 0));
      const rows = compatibleRows.filter((row) => allowLowerQuality || meetsDownloadQuality(row, requestedQuality)).sort((a, b) => {
        if (requestedQuality === "auto") return a.codecRank - b.codecRank || b.pixels - a.pixels;
        const aMeets = meetsDownloadQuality(a, requestedQuality), bMeets = meetsDownloadQuality(b, requestedQuality);
        if (aMeets !== bMeets) return Number(bMeets) - Number(aMeets);
        const aPixels = Math.min(a.width, a.height), bPixels = Math.min(b.width, b.height);
        if (aMeets && a.codecRank === 2 !== (b.codecRank === 2)) return Number(a.codecRank === 2) - Number(b.codecRank === 2);
        return (aMeets ? aPixels - bPixels : bPixels - aPixels) || a.codecRank - b.codecRank;
      });
      if (!rows.length) {
        const strictQuality = compatibleRows.length > 0 && requestedQuality !== "auto" && !allowLowerQuality;
        throw Object.assign(new Error(strictQuality ? `\u672C\u96C6\u6682\u65E0\u5C3A\u5BF8\u53EF\u786E\u8BA4\u4E14\u6EE1\u8DB3 ${requestedQuality} \u7684 H.264/HEVC \u7247\u6E90\uFF0C\u672A\u964D\u7EA7` : Object.values(info.video_list || {}).some((item) => str(item?.codec_type || item?.video_meta?.codec_type).toLowerCase() === "bytevc2") ? "\u672C\u96C6\u4EC5\u63D0\u4F9B\u64AD\u653E\u5668\u4E0D\u652F\u6301\u7684 ByteVC2 \u7F16\u7801\uFF0C\u5F53\u524D\u65E0\u6CD5\u64AD\u653E\u6216\u4E0B\u8F7D\uFF0C\u8BF7\u5728\u5B98\u65B9 App \u89C2\u770B" : "\u672C\u96C6\u6682\u672A\u63D0\u4F9B\u517C\u5BB9\u7684 H.264/HEVC \u7247\u6E90"), {
          code: strictQuality ? "QUALITY_UNAVAILABLE" : "NO_COMPATIBLE_SOURCE",
          ...strictQuality ? { quality: requestedQuality } : {}
        });
      }
      let lastError;
      let incompleteEncryptionMetadata = false;
      const variants = [];
      const seen = /* @__PURE__ */ new Set();
      const bestPixels = rows[0].pixels;
      const selectedRows = requestedQuality === "auto" ? bestPixels > 0 ? rows.filter((row) => row.pixels === bestPixels) : rows.slice(0, 1) : rows;
      for (const selected of selectedRows) {
        try {
          const spade = selected.item.spade_a || selected.item.encrypt_info?.spade_a;
          const encrypt = selected.item.encrypt_info?.encrypt ?? selected.item.encrypt;
          if (requireEncryptionMetadata && !spade && ![false, 0, "0", "false"].includes(encrypt)) {
            if (encrypt == null) incompleteEncryptionMetadata = true;
            throw Object.assign(new Error("\u672C\u96C6\u7247\u6E90\u7F3A\u5C11\u6709\u6548\u89E3\u5BC6\u4FE1\u606F"), { code: "INVALID_RESPONSE" });
          }
          const key = spade ? deriveContentKey(spade) : null;
          for (const candidate of [selected.item.main_url, selected.item.backup_url, ...Array.isArray(selected.item.backup_url_list) ? selected.item.backup_url_list : []]) {
            if (typeof candidate !== "string" || !candidate) continue;
            try {
              const media = info.key_seed ? decryptSpadeUrl(candidate, Buffer.from(info.key_seed, "base64")) : cleanUrl(candidate);
              const url = checkedUrl(media, ["qznovelvod.com", "fqnovelvod.com", "douyinvod.com"]);
              const contentKey = key ? key.toString("hex") : null;
              const identity = `${url}:${contentKey || ""}`;
              if (seen.has(identity)) continue;
              seen.add(identity);
              variants.push({
                url,
                contentKey,
                codec: selected.codec === "bytevc1" ? "hevc" : selected.codec,
                source: "app",
                vid,
                userAgent: inline ? PLAYBACK_UA : VIDEO_UA,
                quality: allowLowerQuality ? selected.width && selected.height ? `${Math.min(selected.width, selected.height)}p` : "" : requestedQuality === "auto" ? selected.quality : requestedQuality,
                ...requestedQuality === "auto" ? {} : { width: selected.width, height: selected.height }
              });
              if (selected.codec === "bytevc2") Object.assign(variants[variants.length - 1], {
                width: selected.width,
                height: selected.height,
                duration: Number(info.video_duration)
              });
            } catch (error) {
              lastError = error;
            }
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (variants.length) return { ...variants[0], variants };
      throw lastError?.code === "SECURITY_BLOCKED" ? lastError : Object.assign(new Error("\u672C\u96C6\u7247\u6E90\u5730\u5740\u6216\u5BC6\u94A5\u65E0\u6CD5\u89E3\u6790"), {
        code: "INVALID_RESPONSE",
        ...incompleteEncryptionMetadata ? {
          incompleteEncryptionMetadata: true,
          minimumPixels: Math.min(rows[0].width, rows[0].height)
        } : {}
      });
    }
    module2.exports = { fetchAppPlayUrl, signedSearchRequest, signedMetadataRequest, signedAccountRequest, parseSearchInteger, preserveLargeJsonIntegers, requestJson, SEARCH_API, SEARCH_UA };
  }
});

// src/native/hongguo.js
var axios = require_axios();
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { URL: URL2 } = require("node:url");
var { normalizeDownloadQuality } = require_download_quality();
var { isPublicMediaUrl, webMediaRequestOptions } = require_web_media_guard();
var { abortError, throwIfAborted } = require_request_signal();
var API = "https://api5-normal-sinfonlineb.fqnovel.com";
var UA = "com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)";
var VIDEO_REFERER = "https://novelquickapp.com/";
var SITE_ORIGIN = "https://hongguoduanju.com";
var WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
var WEB_REFERER = SITE_ORIGIN + "/";
var COMMON_QUERY = {
  ...Object.fromEntries([
    ["klink_egdi", process.env.HONGGUO_KLINK_EGDI],
    ["iid", process.env.HONGGUO_IID],
    ["device_id", process.env.HONGGUO_DEVICE_ID],
    ["cdid", process.env.HONGGUO_CDID]
  ].filter(([, value]) => value)),
  ac: "wifi",
  channel: "oppo_8662_64",
  aid: "8662",
  app_name: "novelread",
  version_code: "71532",
  version_name: "7.1.5.32",
  device_platform: "android",
  os: "android",
  ssmix: "a",
  device_type: "SM-N9860",
  device_brand: "Samsung",
  language: "zh",
  os_api: "28",
  os_version: "9",
  manifest_version_code: "71532",
  resolution: "900*1600",
  dpi: "320",
  update_version_code: "71532",
  host_abi: "arm64-v8a",
  dragon_device_type: "pad",
  pv_player: "71532",
  compliance_status: "0",
  need_personal_recommend: "1",
  player_so_load: "1",
  is_android_pad_screen: "0",
  rom_version: "PQ3A.190705.10241111+release-keys"
};
var HEADERS = {
  "User-Agent": UA,
  "Accept-Encoding": "gzip",
  "Accept": "application/json; charset=utf-8,application/x-protobuf",
  "Content-Type": "application/json; charset=utf-8",
  "Host": "api5-normal-sinfonlineb.fqnovel.com"
};
var DETAIL_BIZ_PARAM = {
  detail_page_version: 0,
  disable_digg_stat: false,
  image_shrink_datas_str: "W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjcyLCJzaHJpbmtfdHlwZSI6NH1d\n",
  need_all_video_definition: false,
  need_mp4_align: false,
  screen_width_px: "900",
  source: 7,
  use_os_player: false,
  use_server_dns: false
};
var MODEL_BIZ_PARAM = {
  detail_page_version: 0,
  device_level: 3,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024
};
async function apiCall(apiPath, body, retries = 3, timeout = 25e3, deadline = 0, requestSignal) {
  const q = { ...COMMON_QUERY, _rticket: Date.now().toString() };
  for (let i = 0; i < retries; i++) {
    throwIfAborted(requestSignal);
    const remaining = deadline ? deadline - Date.now() : timeout;
    if (remaining <= 0) throw new Error("\u8BF7\u6C42\u8D85\u65F6");
    const signal = {};
    try {
      const res = await axios.post(API + apiPath, body, {
        params: q,
        headers: HEADERS,
        timeout: Math.min(timeout, remaining),
        signal: requestSignal,
        // 200 + 空 body 时 axios 会解析成 ''，这里统一按原始字节处理便于判断
        responseType: "arraybuffer",
        transformResponse: [(d) => d]
      });
      throwIfAborted(requestSignal);
      signal.status = res.status;
      signal.logid = res.headers?.["x-tt-logid"];
      const buf = Buffer.from(res.data || []);
      signal.bytes = buf.length;
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (buf.length === 0) {
        const err = new Error(
          `\u63A5\u53E3\u8FD4\u56DE\u7A7A\u54CD\u5E94\uFF08HTTP 200\uFF0C0 \u5B57\u8282\uFF09${signal.logid ? " logid=" + signal.logid : ""}`
        );
        err.code = "EMPTY_RESPONSE";
        err.emptyResponse = true;
        err.detail = signal;
        throw err;
      }
      const text = buf.toString("utf8");
      try {
        return JSON.parse(text);
      } catch (e) {
        const err = new Error(`\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON\uFF08HTTP 200\uFF0C${buf.length} \u5B57\u8282\uFF09: ${text.slice(0, 100)}`);
        err.detail = signal;
        throw err;
      }
    } catch (err) {
      throwIfAborted(requestSignal);
      if (requestSignal && err.code === "ERR_CANCELED") throw abortError();
      if (i === retries - 1) {
        if (err.detail === void 0) err.detail = signal;
        throw err;
      }
      if (err.emptyResponse) {
        if (err.detail === void 0) err.detail = signal;
        throw err;
      }
      const wait = 2e3 * (i + 1);
      if (deadline && Date.now() + wait >= deadline) {
        if (err.detail === void 0) err.detail = signal;
        throw err;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
var responseCache = /* @__PURE__ */ new Map();
var pendingRequests = /* @__PURE__ */ new Map();
var failedWebMedia = /* @__PURE__ */ new Map();
function markWebMediaFailure(playInfo) {
  if (playInfo?.source !== "web" || !playInfo.vid) return;
  failedWebMedia.set(String(playInfo.vid), Date.now() + 5 * 60 * 1e3);
  if (failedWebMedia.size > 128) failedWebMedia.delete(failedWebMedia.keys().next().value);
}
async function cachedRequest(key, ttl, load, { force = false, signal } = {}) {
  throwIfAborted(signal);
  const cached = responseCache.get(key);
  if (!force && cached && cached.expires > Date.now()) return cached.value;
  responseCache.delete(key);
  let job = !force && pendingRequests.get(key);
  if (!job) {
    job = { controller: new AbortController(), consumers: 0, pending: true };
    job.promise = Promise.resolve().then(() => {
      throwIfAborted(job.controller.signal);
      return load(job.controller.signal);
    });
    job.promise.then(() => {
      job.pending = false;
    }, () => {
      job.pending = false;
    });
    pendingRequests.set(key, job);
  }
  job.consumers++;
  let released = false, abort;
  const release = () => {
    if (released) return;
    released = true;
    if (--job.consumers === 0) {
      if (pendingRequests.get(key) === job) pendingRequests.delete(key);
      if (job.pending) job.controller.abort();
    }
  };
  try {
    const value = await new Promise((resolve, reject) => {
      abort = () => {
        release();
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      job.promise.then(resolve, reject);
    });
    throwIfAborted(signal);
    throwIfAborted(job.controller.signal);
    if (pendingRequests.get(key) === job) {
      responseCache.set(key, { value, expires: Date.now() + ttl });
      if (responseCache.size > 128) responseCache.delete(responseCache.keys().next().value);
    }
    return value;
  } finally {
    signal?.removeEventListener("abort", abort);
    release();
  }
}
function normalizeVideoUrl(raw) {
  return String(raw || "").replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&").replace(/([?&])Range=[^&]*/gi, "$1").replace(/[?&]$/, "");
}
async function fetchSiteHtml(url, timeout = 3e4, signal, { trustedOfficialDns = false } = {}) {
  throwIfAborted(signal);
  let guarded = {};
  if (trustedOfficialDns) {
    try {
      if (new URL2(url).origin === SITE_ORIGIN) {
        guarded = { ...webMediaRequestOptions(url, { trustedOfficialDns: true }), adapter: "http" };
      }
    } catch (_) {
    }
  }
  const res = await axios.get(url, {
    ...guarded,
    headers: {
      "User-Agent": WEB_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": WEB_REFERER
    },
    timeout,
    responseType: "text",
    maxRedirects: 5,
    signal
  });
  throwIfAborted(signal);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}
function parseEpisodeListHtml(html, seriesId) {
  const router = require_catalog().readRouterData(html);
  const data = router.loaderData?.["player_(series_id)/page"] ?? router.loaderData?.["player_(series_id)/(vid)/page"] ?? router.loaderData?.detail_page;
  const detail = data?.seriesDetail;
  if (!data || data.isSuccess === false || !/^\d{1,30}$/.test(String(detail?.series_id || "")) || String(detail.series_id) !== String(seriesId) || data.series_id != null && String(data.series_id) !== String(seriesId)) {
    throw new Error("\u5B98\u7F51\u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4\u6216\u7F3A\u5C11\u5267\u96C6\u8EAB\u4EFD");
  }
  if (!Array.isArray(detail.vid_list)) throw new Error("\u5B98\u7F51\u9875\u9762\u672A\u627E\u5230\u5206\u96C6\u6570\u636E\uFF08vid_list\uFF09");
  const vids = detail.vid_list.map(String);
  if (vids.some((vid) => !/^\d{1,30}$/.test(vid)) || new Set(vids).size !== vids.length) {
    throw new Error("\u5B98\u7F51\u5206\u96C6\u6570\u636E\u5F02\u5E38");
  }
  if (!vids.length) throw new Error("\u5B98\u7F51\u5206\u96C6\u5217\u8868\u4E3A\u7A7A");
  const seriesTitle = typeof detail.series_name === "string" ? detail.series_name : "\u672A\u547D\u540D\u77ED\u5267";
  const cover = typeof detail.series_cover === "string" ? detail.series_cover : "";
  const accessible = detail.accessible_episode_cnt;
  const webAccessibleEpisodes = accessible != null && /^\d+$/.test(String(accessible)) ? Math.min(Number(accessible), vids.length) : null;
  const episodes = vids.map((vid, i) => ({
    vid,
    vid_index: i + 1,
    title: "",
    series_id: String(seriesId),
    series_title: seriesTitle,
    cover,
    web_available: webAccessibleEpisodes === null ? null : i < webAccessibleEpisodes
  }));
  return {
    series_id: String(seriesId),
    series_title: seriesTitle,
    cover: cover || episodes[0] && episodes[0].cover || "",
    total: episodes.length,
    web_accessible_episodes: webAccessibleEpisodes,
    episodes,
    source: "web"
    // 标记来源，便于排查
  };
}
async function fetchPlayUrlFromWeb(vid, sid, onFailure, signal) {
  const candidates = [];
  if (sid) candidates.push(`${SITE_ORIGIN}/player/${encodeURIComponent(sid)}/${encodeURIComponent(vid)}`);
  candidates.push(`${SITE_ORIGIN}/player/_/${encodeURIComponent(vid)}`);
  let lastErr = null;
  for (const url of candidates) {
    throwIfAborted(signal);
    try {
      const html = await fetchSiteHtml(url, 4e3, signal);
      throwIfAborted(signal);
      const router = require_catalog().readRouterData(html);
      const data = router.loaderData?.["player_(series_id)/(vid)/page"];
      const actualSid = String(data?.series_id || "");
      lastErr = { code: !data ? "MISSING_MODEL" : data.isSuccess === false ? "BUSINESS_REJECTED" : data.publicVideoSeo?.available === false ? "NO_PLAYABLE_SOURCE" : "INVALID_RESPONSE" };
      if (!data || data.isSuccess === false || String(data.vid) !== String(vid) || !/^\d+$/.test(actualSid) || sid && actualSid !== String(sid) || String(data.seriesDetail?.series_id) !== actualSid || data.publicVideoSeo?.available !== true || String(data.publicVideoSeo.itemId) !== String(vid) || String(data.publicVideoSeo.seriesId) !== actualSid) continue;
      if (data.protectedPlayback === true) {
        lastErr = { code: "PREVIEW_ONLY" };
        break;
      }
      const matchesPlayer = (value, videoUrl) => {
        try {
          const target = new URL2(value);
          return target.origin === SITE_ORIGIN && !target.username && !target.password && (target.pathname === `/player/${actualSid}/${String(vid)}` || // The current canonical page omits vid; its official media path must still identify this episode.
          target.pathname === `/player/${actualSid}` && videoUrl.origin === SITE_ORIGIN && videoUrl.pathname.startsWith(`/video/public/${String(vid)}/`));
        } catch (_) {
          return false;
        }
      };
      for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1])) continue;
        let video;
        try {
          video = JSON.parse(script[2]);
        } catch (_) {
          continue;
        }
        if (video?.["@type"] !== "VideoObject") continue;
        let videoUrl;
        try {
          videoUrl = new URL2(normalizeVideoUrl(video.contentUrl));
        } catch (_) {
          continue;
        }
        if (!matchesPlayer(video.url, videoUrl) || video["@id"] && !matchesPlayer(video["@id"], videoUrl)) continue;
        if (!isPublicMediaUrl(videoUrl.href)) {
          lastErr = { code: "SECURITY_BLOCKED" };
          continue;
        }
        return { url: videoUrl.href, spadeA: null, codec: "", source: "web", vid: String(vid), userAgent: WEB_UA, referer: WEB_REFERER };
      }
    } catch (e) {
      throwIfAborted(signal);
      if (signal && e.code === "ERR_CANCELED") throw abortError();
      lastErr = e;
    }
  }
  if (lastErr) console.warn("[Web] \u53D6\u64AD\u653E\u76F4\u94FE\u5931\u8D25:", sourceFailure("web", lastErr).message);
  onFailure?.(lastErr);
  return null;
}
function shareHttpUrl(value, base) {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/.test(value)) {
    throw new Error("\u5206\u4EAB\u94FE\u63A5\u65E0\u6548\u6216\u8FC7\u957F");
  }
  let url;
  try {
    url = new URL2(value, base);
  } catch (_) {
    throw new Error("\u8BF7\u8F93\u5165\u6709\u6548\u7684 HTTP \u6216 HTTPS \u5206\u4EAB\u94FE\u63A5");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 4096) {
    throw new Error("\u4EC5\u652F\u6301\u4E0D\u542B\u8D26\u53F7\u5BC6\u7801\u7684 HTTP \u6216 HTTPS \u5206\u4EAB\u94FE\u63A5");
  }
  if (!isPublicMediaUrl(url.href)) throw new Error("\u5206\u4EAB\u94FE\u63A5\u5FC5\u987B\u6307\u5411\u516C\u7F51 HTTP \u6216 HTTPS \u5730\u5740");
  return url.href;
}
function seriesIdFromShareUrl(value) {
  let url;
  try {
    url = new URL2(value);
  } catch (_) {
    return "";
  }
  const direct = url.searchParams.get("video_series_id") || url.searchParams.get("series_id");
  if (/^\d{1,30}$/.test(direct || "")) return direct;
  const player = url.pathname.match(/^\/player\/(\d{1,30})(?:\/|$)/);
  if (player) return player[1];
  const scheme = url.searchParams.get("schemeParams");
  if (scheme) {
    try {
      const raw = decodeURIComponent(scheme);
      const match = raw.match(/"video_id"\s*:\s*"(\d{1,30})"/);
      if (match) return match[1];
    } catch (_) {
    }
  }
  return "";
}
async function resolveSeriesId(shareUrl) {
  if (typeof shareUrl !== "string" || shareUrl.length > 8192) throw new Error("\u5206\u4EAB\u5185\u5BB9\u65E0\u6548\u6216\u8FC7\u957F");
  const trimmed = shareUrl.trim();
  if (trimmed.startsWith("reelshort:")) return require_reelshort().resolveSeriesId(trimmed);
  if (trimmed.startsWith("dramabox:")) return require_dramabox().resolveSeriesId(trimmed);
  if (trimmed.startsWith("custom:")) {
    if (!/^custom:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}:\d{1,30}$/i.test(trimmed)) throw new Error("\u81EA\u5B9A\u4E49\u5267\u96C6\u7F16\u53F7\u65E0\u6548");
    require_custom_source().assertEnabled(trimmed);
    return trimmed.toLowerCase();
  }
  if (/^\d{1,30}$/.test(trimmed)) return trimmed;
  const linkPattern = /https?:\/\/[^\s<>"'，。！？；、【】（）]+/gi;
  const textId = trimmed.replace(linkPattern, " ").match(/(?:^|[^A-Za-z0-9_])(?:video_)?series_id["']?\s*[:=]\s*["']?(\d{1,30})(?![A-Za-z0-9_])/i)?.[1];
  if (textId) return textId;
  const link = trimmed.match(linkPattern)?.[0];
  let finalUrl = link ? shareHttpUrl(link.replace(/[),.;!]+$/, "")) : "";
  if (finalUrl && new URL2(finalUrl).origin === "https://www.reelshort.com") return require_reelshort().resolveSeriesId(finalUrl);
  if (finalUrl && ["https://www.dramabox.com", "https://www.dramaboxdb.com"].includes(new URL2(finalUrl).origin)) return require_dramabox().resolveSeriesId(finalUrl);
  const initialId = finalUrl ? seriesIdFromShareUrl(finalUrl) : "";
  if (initialId) return initialId;
  if (!finalUrl) throw new Error("\u8BF7\u8F93\u5165\u6709\u6548\u7684 HTTP \u6216 HTTPS \u5206\u4EAB\u94FE\u63A5\uFF0C\u6216\u5267\u96C6 ID");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25e3);
  let bodyText;
  try {
    for (let redirects = 0; ; redirects++) {
      const res = await axios.get(finalUrl, {
        ...webMediaRequestOptions(finalUrl),
        headers: { "User-Agent": WEB_UA },
        adapter: "http",
        timeout: 25e3,
        signal: controller.signal,
        responseType: "text",
        transformResponse: [(data) => data],
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 1024,
        // Follow manually so every Location is bounded and validated before Axios sees it.
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 300 || [301, 302, 303, 307, 308].includes(status)
      });
      if (res.status >= 300 && res.status < 400) {
        if (redirects >= 5) throw new Error("\u5206\u4EAB\u94FE\u63A5\u8DF3\u8F6C\u6B21\u6570\u8FC7\u591A");
        finalUrl = shareHttpUrl(res.headers.location, finalUrl);
        const redirectId = seriesIdFromShareUrl(finalUrl);
        if (redirectId) return redirectId;
        continue;
      }
      bodyText = typeof res.data === "string" ? res.data : "";
      break;
    }
  } catch (error) {
    const reason = controller.signal.aborted ? "\u5206\u4EAB\u94FE\u63A5\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5" : `\u5206\u4EAB\u94FE\u63A5\u52A0\u8F7D\u5931\u8D25\uFF1A${error.message || "\u8BF7\u68C0\u67E5\u94FE\u63A5\u540E\u91CD\u8BD5"}`;
    throw new Error(reason);
  } finally {
    clearTimeout(timer);
  }
  const urlId = seriesIdFromShareUrl(finalUrl);
  if (urlId) return urlId;
  const match = bodyText.match(/video_series_id=(\d{1,30})(?!\d)/) || bodyText.match(/"(?:video_id|series_id)"\s*:\s*"(\d{1,30})"/);
  if (match) return match[1];
  throw new Error("\u65E0\u6CD5\u4ECE\u5206\u4EAB\u94FE\u63A5\u89E3\u6790\u5267\u96C6 ID");
}
async function fetchEpisodeList(seriesId, options = {}) {
  if (String(seriesId).startsWith("dramabox:")) return require_dramabox().fetchEpisodeList(seriesId, options);
  if (String(seriesId).startsWith("reelshort:")) return require_reelshort().fetchEpisodeList(seriesId);
  if (String(seriesId).startsWith("custom:")) return require_custom_source().fetchEpisodeList(seriesId);
  if (String(seriesId).startsWith("hema:")) return require_hema().fetchEpisodeList(seriesId);
  if (String(seriesId).startsWith("xifan:")) return require_xifan().fetchEpisodeList(seriesId);
  return cachedRequest(
    `episodes:${seriesId}`,
    6e4,
    () => fetchEpisodeListFresh(seriesId, { deadline: Number(options.deadline) || 0 }),
    { force: options.force === true }
  );
}
function describeWebLoadError(error) {
  const message = String(error?.message || "");
  if (error?.code === "ERR_CANCELED" || /aborted|canceled|timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) {
    return "\u52A0\u8F7D\u8D85\u65F6\u6216\u8FDE\u63A5\u4E2D\u65AD";
  }
  return message || "\u52A0\u8F7D\u5931\u8D25";
}
async function fetchEpisodeListFromWeb(seriesId, deadline = 0) {
  const id = String(seriesId);
  const race = async (timeout, trustedOfficialDns) => {
    const budget = deadline ? Math.min(timeout, deadline - Date.now()) : timeout;
    if (budget <= 0) throw new Error("\u52A0\u8F7D\u8D85\u65F6\u6216\u8FDE\u63A5\u4E2D\u65AD");
    const controller = new AbortController();
    const attempts = [
      () => fetchSiteHtml(`${SITE_ORIGIN}/player/${encodeURIComponent(id)}`, budget, controller.signal, { trustedOfficialDns }),
      () => fetchSiteHtml(`${SITE_ORIGIN}/detail?series_id=${encodeURIComponent(id)}`, budget, controller.signal, { trustedOfficialDns })
    ].map((run) => run().then((html) => parseEpisodeListHtml(html, id)));
    attempts.forEach((promise) => promise.catch(() => {
    }));
    try {
      return await Promise.any(attempts);
    } catch (aggregate) {
      throw aggregate.errors?.[0] || aggregate;
    } finally {
      controller.abort();
    }
  };
  let firstValue = null;
  let firstError = null;
  const first = race(1500, true).then((value) => {
    firstValue = value;
    return value;
  }, (error) => {
    firstError = error;
    throw error;
  });
  const hedge = (async () => {
    const wait = deadline ? Math.min(600, Math.max(0, deadline - Date.now())) : 600;
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (firstValue) return firstValue;
    if (deadline && Date.now() >= deadline) throw new Error("\u52A0\u8F7D\u8D85\u65F6\u6216\u8FDE\u63A5\u4E2D\u65AD");
    return Promise.any([race(3500, true), race(3500, false)]);
  })();
  try {
    return await Promise.any([first, hedge]);
  } catch (aggregate) {
    const nested = (aggregate.errors || [aggregate]).flatMap((error) => error?.errors || [error]);
    const second = nested.find((error) => error !== firstError) || nested[0] || aggregate;
    throw new Error(`${describeWebLoadError(firstError)}\uFF1B\u91CD\u8BD5\u5931\u8D25\uFF1A${describeWebLoadError(second)}`);
  }
}
async function fetchEpisodeListFresh(seriesId, { deadline = 0 } = {}) {
  let webError;
  try {
    return await fetchEpisodeListFromWeb(seriesId, deadline);
  } catch (error) {
    webError = error;
  }
  const body = {
    biz_param: DETAIL_BIZ_PARAM,
    dr_scene: "preload",
    series_id: seriesId
  };
  let j;
  try {
    j = await apiCall("/novel/player/multi_video_detail/preload/v1", body, 3, 25e3, deadline);
  } catch (e) {
    throw new Error(`\u83B7\u53D6\u5206\u96C6\u5931\u8D25\uFF1A\u5B98\u7F51\u6570\u636E\u6E90\uFF08${webError.message}\uFF09\uFF0C\u5907\u7528\u63A5\u53E3\uFF08${e.message}\uFF09`);
  }
  if (!j || j.code !== 0) {
    throw new Error("detail API \u5931\u8D25: " + JSON.stringify(j || {}).slice(0, 200));
  }
  const d = j.data || {};
  const requested = String(seriesId);
  const sid = Object.prototype.hasOwnProperty.call(d, requested) ? requested : "";
  if (!sid) {
    throw new Error("\u5907\u7528\u63A5\u53E3\u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
  }
  const vd = d[sid]?.video_data || {};
  if (vd.series_id && String(vd.series_id) !== sid) {
    throw new Error("\u5907\u7528\u63A5\u53E3\u8FD4\u56DE\u7684\u5267\u96C6\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
  }
  const vl = vd.video_list || [];
  if (vl.some((item) => item?.series_id && String(item.series_id) !== sid)) {
    throw new Error("\u5907\u7528\u63A5\u53E3\u8FD4\u56DE\u4E86\u5176\u4ED6\u5267\u96C6\u7684\u5206\u96C6");
  }
  const eps = vl.map((item) => ({
    vid: String(item.vid),
    vid_index: item.vid_index || 0,
    title: item.title || "",
    series_id: String(item.series_id || sid),
    series_title: vd.series_title || "",
    cover: vd.series_cover || vd.cover_url || item.cover_url || ""
  }));
  if (!eps.length) throw new Error("\u5907\u7528\u63A5\u53E3\u5206\u96C6\u5217\u8868\u4E3A\u7A7A");
  eps.sort((a, b) => a.vid_index - b.vid_index);
  return {
    series_id: String(sid),
    series_title: vd.series_title || "\u672A\u547D\u540D\u77ED\u5267",
    cover: vd.series_cover || vd.cover_url || eps[0] && eps[0].cover || "",
    total: eps.length,
    episodes: eps
  };
}
function streamScore(v) {
  const meta = v.video_meta || {};
  const defStr = String(meta.definition || "");
  let defNum = 0;
  const m = defStr.match(/(\d+)\s*p/i);
  if (m) {
    defNum = parseInt(m[1], 10);
  } else {
    const map = { "4k": 2160, "2k": 1440, "fhd": 1080, "fullhd": 1080, "hd": 720, "sd": 480, "ld": 360 };
    defNum = map[defStr.toLowerCase()] || 0;
  }
  const w = parseInt(meta.vwidth, 10) || 0;
  const h = parseInt(meta.vheight, 10) || 0;
  if (w > 0 && h > 0) defNum = Math.min(w, h);
  const bitrate = parseInt(meta.bitrate || meta.real_bitrate, 10) || 0;
  return { defNum, pixels: w * h, bitrate };
}
function parseModelVideo(vm) {
  if (typeof vm !== "string") return [null, null, null];
  let vmj;
  try {
    vmj = JSON.parse(vm);
  } catch (e) {
    return [null, null, null];
  }
  const vl = vmj.video_list || [];
  const rank = (codec) => {
    if (["h264", "avc", "avc1"].includes(codec)) return 0;
    if (["h265", "h265_hvc1", "hevc", "hvc1", "hev1", "bytevc1"].includes(codec)) return 1;
    return 2;
  };
  const cmp = (a, b) => {
    if (a.codecRank !== b.codecRank) return b.codecRank - a.codecRank;
    if (a.defNum !== b.defNum) return a.defNum - b.defNum;
    if (a.pixels !== b.pixels) return a.pixels - b.pixels;
    return a.bitrate - b.bitrate;
  };
  let best = null;
  let bestScore = null;
  for (const v of Object.values(vl)) {
    let url;
    for (const raw of [v.main_url, v.backup_url]) {
      try {
        const candidate = new URL2(normalizeVideoUrl(raw));
        if (["https:", "http:"].includes(candidate.protocol) && !candidate.username && !candidate.password && isPublicMediaUrl(candidate.href)) {
          url = candidate.href;
          break;
        }
      } catch (_) {
      }
    }
    if (!url) continue;
    const codec = String(v.video_meta?.codec_type || "").toLowerCase();
    const ei = v.encrypt_info || {};
    const s = { ...streamScore(v), codecRank: rank(codec) };
    if (!bestScore || cmp(s, bestScore) > 0) {
      bestScore = s;
      best = [url, ei.spade_a || null, codec];
    }
  }
  return best || [null, null, null];
}
async function fetchPlayUrlSingle(vid, sid, options = {}) {
  try {
    throwIfAborted(options.signal);
    const quality = normalizeDownloadQuality(options.quality);
    if (String(vid).startsWith("reelshort:") || String(sid).startsWith("reelshort:")) return require_reelshort().fetchPlayUrlSingle(vid, sid);
    if (String(vid).startsWith("dramabox:") || String(sid).startsWith("dramabox:")) return require_dramabox().fetchPlayUrlSingle(vid, sid, options);
    if (String(vid).startsWith("custom:") || String(sid).startsWith("custom:")) return require_custom_source().fetchPlayUrlSingle(vid, sid, options);
    if (String(vid).startsWith("hema:") || String(sid).startsWith("hema:")) return require_hema().fetchPlayUrlSingle(vid, sid);
    if (String(vid).startsWith("xifan:") || String(sid).startsWith("xifan:")) return require_xifan().fetchPlayUrlSingle(vid, sid);
    const skipWeb = (failedWebMedia.get(String(vid)) || 0) > Date.now();
    const allowLowerQuality = options.allowLowerQuality === true && quality !== "auto";
    const cacheKey = `play:${sid || ""}:${vid}${quality === "auto" ? "" : `:${quality}`}${skipWeb ? ":fallback" : ""}${allowLowerQuality ? ":lower-quality" : ""}`;
    const result = await cachedRequest(cacheKey, 3e4, (signal) => quality === "auto" ? fetchPlayUrlFresh(vid, sid, skipWeb, signal) : require_app_source().fetchAppPlayUrl(String(vid), { quality, allowLowerQuality, signal }).catch((error) => {
      throwIfAborted(signal);
      if (error.code === "ERR_CANCELED") throw error;
      throw unavailableSources([sourceFailure("app", error)], allowLowerQuality ? "auto" : quality);
    }), options);
    throwIfAborted(options.signal);
    if (skipWeb && result.source === "web" && responseCache.get(cacheKey)?.value === result) responseCache.delete(cacheKey);
    return result;
  } catch (error) {
    if (options.signal?.aborted) error = abortError(options.signal);
    if (error.code === "ERR_CANCELED") return { url: null, spadeA: null, codec: null, error: "\u5DF2\u53D6\u6D88 App \u7247\u6E90\u8BF7\u6C42", code: "ERR_CANCELED" };
    return {
      url: null,
      spadeA: null,
      codec: null,
      error: error.message,
      ...error.code === "ETIMEDOUT" ? { code: error.code } : {},
      ...error.code === "SOURCE_UNAVAILABLE" ? { code: error.code, sources: error.sources } : {}
    };
  }
}
function sourceFailure(source, error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (code === "ERR_CANCELED") return { source, code, message: "\u5DF2\u53D6\u6D88 App \u7247\u6E90\u8BF7\u6C42" };
  const networkDetails = { DNS: "DNS \u89E3\u6790\u5931\u8D25", CONNECTION: "\u8FDE\u63A5\u5931\u8D25", TLS: "TLS \u8BC1\u4E66\u6216\u63E1\u624B\u5931\u8D25" };
  const network = typeof error?.networkFailure === "string" && Object.hasOwn(networkDetails, error.networkFailure) ? { networkFailure: error.networkFailure } : {};
  if (code === "DEVICE_REGISTRATION_FAILED") {
    const reason = String(error.registrationFailure || "");
    const safeReason = /^(?:TIMEOUT|NETWORK_ERROR|EMPTY_RESPONSE|INVALID_RESPONSE|BUSINESS_REJECTED|SECURITY_BLOCKED|HTTP_[3-5]\d{2})$/.test(reason) ? reason : "INVALID_RESPONSE";
    const descriptions = {
      TIMEOUT: "\u8BF7\u6C42\u8D85\u65F6",
      NETWORK_ERROR: "\u7F51\u7EDC\u8FDE\u63A5\u5931\u8D25",
      EMPTY_RESPONSE: "\u4E0A\u6E38\u8FD4\u56DE\u7A7A\u54CD\u5E94",
      INVALID_RESPONSE: "\u4E0A\u6E38\u672A\u8FD4\u56DE\u6709\u6548\u8BBE\u5907\u7F16\u53F7",
      BUSINESS_REJECTED: "\u4E0A\u6E38\u62D2\u7EDD\u6CE8\u518C",
      SECURITY_BLOCKED: "\u6CE8\u518C\u8BF7\u6C42\u88AB\u5B89\u5168\u6821\u9A8C\u963B\u6B62"
    };
    const detail = reason === "NETWORK_ERROR" && network.networkFailure ? networkDetails[network.networkFailure] : Object.hasOwn(descriptions, reason) ? descriptions[reason] : /^HTTP_[3-5]\d{2}$/.test(reason) ? `HTTP ${reason.slice(5)}` : "";
    const transient = /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(reason);
    return {
      source,
      code: /^(?:TIMEOUT|NETWORK_ERROR|HTTP_[3-5]\d{2})$/.test(safeReason) ? safeReason : code,
      registrationFailure: safeReason,
      ...reason === "NETWORK_ERROR" ? network : {},
      message: `\u533F\u540D\u64AD\u653E\u8BBE\u5907\u6CE8\u518C\u5931\u8D25${detail ? `\uFF08${detail}\uFF09` : ""}${transient ? "\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\uFF0C10 \u79D2\u540E\u91CD\u8BD5" : "\uFF1B\u672C\u673A\u51B7\u5374 10 \u79D2\u540E\u53EF\u624B\u52A8\u91CD\u8BD5\uFF0C\u4E0A\u6E38\u4F55\u65F6\u6062\u590D\u6682\u65E0\u6CD5\u786E\u8BA4"}`
    };
  }
  const status = Number(error?.status || error?.response?.status || message.match(/HTTP\s+(\d{3})/)?.[1]);
  if (status >= 300 && status <= 599) return { source, code: `HTTP_${status}`, message: `\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${status}\uFF09` };
  if (code === "SECURITY_BLOCKED" || code.startsWith("ERR_WEB_MEDIA_")) return { source, code: "SECURITY_BLOCKED", message: "\u7247\u6E90\u5730\u5740\u88AB\u5B89\u5168\u6821\u9A8C\u963B\u6B62" };
  if (code === "EMPTY_RESPONSE" || error?.emptyResponse || /接口返回空响应/.test(message)) {
    return { source, code: "EMPTY_RESPONSE", message: "\u64AD\u653E\u63A5\u53E3\u8FD4\u56DE\u7A7A\u54CD\u5E94\uFF0C\u539F\u56E0\u5C1A\u672A\u786E\u8BA4" };
  }
  if (["ECONNABORTED", "ETIMEDOUT", "TIMEOUT"].includes(code) || /超时|timeout/i.test(message)) return { source, code: "TIMEOUT", message: "\u8BF7\u6C42\u8D85\u65F6" };
  if (network.networkFailure || ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ERR_NETWORK"].includes(code)) return {
    source,
    code: "NETWORK_ERROR",
    ...network,
    message: network.networkFailure ? `${networkDetails[network.networkFailure]}\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5` : "\u7F51\u7EDC\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"
  };
  if (code === "PREVIEW_ONLY") return { source, code, message: "\u7F51\u9875\u4EC5\u63D0\u4F9B\u9884\u89C8\uFF0C\u672A\u4F5C\u4E3A\u5B8C\u6574\u7247\u6E90" };
  if (code === "QUALITY_UNAVAILABLE") return { source, code, message: ["720p", "1080p"].includes(error?.quality) ? `\u672C\u96C6\u6682\u65E0\u5C3A\u5BF8\u53EF\u786E\u8BA4\u4E14\u6EE1\u8DB3 ${error.quality} \u7684 H.264/HEVC \u7247\u6E90\uFF0C\u672A\u964D\u7EA7` : "\u672A\u53D6\u5F97\u6EE1\u8DB3\u6240\u9009\u6E05\u6670\u5EA6\u7684\u7247\u6E90\uFF0C\u672A\u964D\u7EA7" };
  if (code === "NO_COMPATIBLE_SOURCE") return { source, code, message: "\u672C\u96C6\u6682\u672A\u63D0\u4F9B\u517C\u5BB9\u7684 H.264/HEVC \u7247\u6E90" };
  if (code === "BUSINESS_REJECTED") return { source, code, message: "\u63A5\u53E3\u6682\u65F6\u62D2\u7EDD\u672C\u6B21\u8BF7\u6C42" };
  if (code === "MISSING_MODEL" || /未返回目录数据/.test(message)) return { source, code: "MISSING_MODEL", message: "\u63A5\u53E3\u672A\u8FD4\u56DE\u672C\u96C6\u7247\u6E90\u6A21\u578B" };
  if (code === "INVALID_RESPONSE" || /空响应|有效数据|目录数据不完整|JSON/.test(message)) return { source, code: "INVALID_RESPONSE", message: "\u7247\u6E90\u6570\u636E\u65E0\u6CD5\u89E3\u6790" };
  return { source, code: "NO_PLAYABLE_SOURCE", message: "\u6682\u672A\u53D6\u5F97\u6709\u6548\u7247\u6E90" };
}
function unavailableSources(sources, quality = "auto") {
  const names = { web: "\u7F51\u9875", app: "App", api: "\u65E7\u63A5\u53E3" };
  const error = new Error(`\u672C\u96C6\u53D6\u6E90\u5931\u8D25${quality === "auto" ? "" : `\uFF08\u6240\u9009\u6E05\u6670\u5EA6 ${quality}\uFF0C\u672A\u964D\u7EA7\uFF09`}\uFF1A${sources.map((item) => `${names[item.source]}\uFF1A${item.message}`).join("\uFF1B")}\u3002\u8BF7\u91CD\u8BD5\u6216\u5728\u5B98\u65B9 App \u786E\u8BA4\u53EF\u64AD\u60C5\u51B5\u3002`);
  error.code = "SOURCE_UNAVAILABLE";
  error.sources = sources;
  return error;
}
async function fetchPlayUrlFresh(vid, sid, skipWeb = false, signal) {
  throwIfAborted(signal);
  const sources = [];
  const web = !skipWeb && await fetchPlayUrlFromWeb(vid, sid, (error) => sources.push(sourceFailure("web", error)), signal);
  throwIfAborted(signal);
  if (web && web.url) return web;
  try {
    const result = await require_app_source().fetchAppPlayUrl(String(vid), { signal });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    if (error.code === "ERR_CANCELED") throw error;
    sources.push(sourceFailure("app", error));
  }
  const body = {
    biz_param: MODEL_BIZ_PARAM,
    dr_scene: "preload",
    mixed_video_id_map: { "1004": [vid] }
  };
  try {
    const j = await apiCall("/novel/player/multi_video_model/preload/v1", body, 1, 6e3, 0, signal);
    throwIfAborted(signal);
    const item = j?.data?.[vid] || {};
    const [url, spadeA, codec] = parseModelVideo(item.video_model);
    if (url) return { url, spadeA, codec, source: "api", vid: String(vid), userAgent: UA };
    sources.push(sourceFailure("api"));
  } catch (e) {
    throwIfAborted(signal);
    if (e.code === "ERR_CANCELED") throw e;
    sources.push(sourceFailure("api", e));
  }
  if (skipWeb) {
    const lastWeb = await fetchPlayUrlFromWeb(vid, sid, (error) => sources.push(sourceFailure("web", error)), signal);
    throwIfAborted(signal);
    if (lastWeb?.url) return lastWeb;
  }
  throw unavailableSources(sources);
}
function avBase64Decode(s) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const table = {};
  for (let i2 = 0; i2 < chars.length; i2++) table[chars.charCodeAt(i2)] = i2;
  const dst = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const vals = [];
    let ok = true;
    for (let j = 0; j < 4; j++) {
      const c = s.charCodeAt(i + j);
      if (c in table) {
        vals.push(table[c]);
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) {
      let v2 = 0;
      for (let j2 = 0; j2 < vals.length; j2++) {
        v2 = v2 << 6 | vals[j2];
      }
      if (vals.length === 3) {
        dst.push(v2 >> 10 & 255);
        dst.push(v2 >> 2 & 255);
      } else if (vals.length === 2) {
        dst.push(v2 >> 4 & 255);
      }
      break;
    }
    const v = vals[0] << 18 | vals[1] << 12 | vals[2] << 6 | vals[3];
    dst.push(v >> 16 & 255);
    dst.push(v >> 8 & 255);
    dst.push(v & 255);
    i += 4;
  }
  return Buffer.from(dst);
}
function deriveKey(spadeA) {
  if (!spadeA) return null;
  const buf = avBase64Decode(spadeA);
  const L = buf.length;
  if (L < 3) return null;
  const key0 = buf[0] ^ buf[1] ^ buf[2];
  const x27 = key0 - 48;
  const w22 = L - key0 + 47;
  if (x27 < 2 || w22 < 2 || w22 > L - 1) return null;
  const x21 = Buffer.from(buf.subarray(1, 1 + w22));
  let w11 = 85, w12 = 250, w10 = 235;
  for (let i = 0; i < x21.length; i++) {
    const w13 = x21[i];
    const pc = i.toString(2).split("1").length - 1;
    const w14 = (i & 1) === 0 ? w12 : w11;
    if ((i & 1) === 1) {
      w11 = w13;
    } else {
      w12 = w13;
    }
    const w13_xor = w14 ^ x21[i];
    const w14_sub = w10 - pc;
    x21[i] = w14_sub + w13_xor & 255;
  }
  const c0 = x21[0];
  let hval = 0;
  if (48 <= c0 && c0 <= 57) {
    hval = c0 - 48;
  } else if (97 <= c0 && c0 <= 122) {
    hval = c0 - 87;
  } else {
    return null;
  }
  const w9 = w22 - hval;
  if (w9 < 2) return null;
  const strA = x21.subarray(1, 1 + w9 - 1).toString("ascii");
  if (strA.length !== 32) return null;
  try {
    return Buffer.from(strA, "hex");
  } catch (e) {
    return null;
  }
}
function aes128EcbEncrypt(key16, data) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key16, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function decryptSample(key, nonce, cipher) {
  if (!cipher || cipher.length === 0) return Buffer.alloc(0);
  const nblocks = Math.ceil(cipher.length / 16);
  const full = Buffer.alloc(nblocks * 16);
  for (let k = 0; k < nblocks; k++) {
    nonce.copy(full, k * 16, 0, 8);
    full.writeBigUInt64BE(BigInt(k), k * 16 + 8);
  }
  const ks = aes128EcbEncrypt(key, full);
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    plain[i] = cipher[i] ^ ks[i];
  }
  return plain;
}
function parseBoxes(data, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString("latin1");
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) break;
    let children = null;
    if (["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta"].includes(typ)) {
      children = parseBoxes(data, off + hdr, off + size);
    }
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  return boxes;
}
function rebuildMoov(data, moovOff, moovSize, top) {
  const moovBox = top.find((b) => b.typ === "moov");
  if (!moovBox) throw new Error("no moov box");
  function clone(box) {
    return {
      typ: box.typ,
      off: box.off,
      size: box.size,
      hdr: box.hdr,
      children: box.children ? box.children.map(clone) : null
    };
  }
  function prune(box) {
    if (!box.children) return box;
    const keep = [];
    for (const c of box.children) {
      if (["senc", "saio", "saiz", "sgpd", "sbgp"].includes(c.typ)) continue;
      keep.push(prune(c));
    }
    box.children = keep;
    return box;
  }
  const tree = prune(clone(moovBox));
  function* walkChildren(box) {
    for (const c of box.children || []) {
      yield c;
      for (const x of walkChildren(c)) yield x;
    }
  }
  const patches = {};
  for (const b of walkChildren(tree)) {
    if (b.typ === "stsd") {
      const content = b.off + 8;
      const count = data.readUInt32BE(content + 4);
      let p = content + 8;
      const entries = [];
      for (let i = 0; i < count; i++) {
        let esize = data.readUInt32BE(p);
        const etyp = data.subarray(p + 4, p + 8).toString("latin1");
        if (etyp === "encv" || etyp === "enca") {
          const hdrSize = etyp === "encv" ? 78 : 28;
          const children = parseBoxes(data, p + 8 + hdrSize, p + esize);
          let newType = "mp4a";
          if (etyp === "encv") {
            const sinf = children.find((child) => child.typ === "sinf");
            const frma = sinf && parseBoxes(data, sinf.off + sinf.hdr, sinf.off + sinf.size).find((child) => child.typ === "frma");
            const original = frma && frma.size === frma.hdr + 4 ? data.toString("latin1", frma.off + frma.hdr, frma.off + frma.hdr + 4) : null;
            const avc = children.some((child) => child.typ === "avcC");
            const hevc = children.some((child) => child.typ === "hvcC");
            const bvc2 = children.some((child) => child.typ === "bv2C");
            newType = original || (avc && !hevc && !bvc2 ? "avc1" : hevc && !avc && !bvc2 ? "hvc1" : null);
            const matchingConfiguration = newType === "bvc2" ? bvc2 && !avc && !hevc : newType?.startsWith("avc") ? avc && !hevc && !bvc2 : hevc && !avc && !bvc2;
            if (!["avc1", "avc3", "hvc1", "hev1", "bvc2"].includes(newType) || !matchingConfiguration) {
              throw new Error("\u65E0\u6CD5\u786E\u5B9A\u52A0\u5BC6\u89C6\u9891\u7684\u539F\u59CB\u7F16\u7801\uFF08codec\uFF09\uFF0C\u8BF7\u66F4\u6362\u7247\u6E90\u91CD\u8BD5\u3002");
            }
          }
          const entry = Buffer.alloc(8 + hdrSize);
          entry.writeUInt32BE(0, 0);
          entry.write(newType, 4, 4, "latin1");
          data.copy(entry, 8, p + 8, p + 8 + hdrSize);
          const entryExtra = Buffer.concat(children.filter((child) => child.typ !== "sinf").map((child) => data.subarray(child.off, child.off + child.size)));
          const fullEntry = Buffer.concat([entry, entryExtra]);
          fullEntry.writeUInt32BE(fullEntry.length, 0);
          entries.push(fullEntry);
        } else {
          entries.push(data.subarray(p, p + esize));
        }
        p += esize;
      }
      const stsdHdr = Buffer.alloc(16);
      data.copy(stsdHdr, 0, b.off, content + 8);
      stsdHdr.writeUInt32BE(entries.length, 12);
      const fullStsd = Buffer.concat([stsdHdr, ...entries]);
      fullStsd.writeUInt32BE(fullStsd.length, 0);
      patches[b.off] = fullStsd;
    }
  }
  function serialize(box) {
    if (!box.children) {
      return patches[box.off] || data.subarray(box.off, box.off + box.size);
    }
    const body = Buffer.concat(box.children.map(serialize));
    const hdrb = Buffer.alloc(box.hdr);
    data.copy(hdrb, 0, box.off, box.off + box.hdr);
    if (box.hdr === 8) {
      hdrb.writeUInt32BE(8 + body.length, 0);
    } else {
      hdrb.writeUInt32BE(1, 0);
      hdrb.writeBigUInt64BE(BigInt(16 + body.length), 8);
    }
    return Buffer.concat([hdrb, body]);
  }
  const first = serialize(tree);
  const delta = moovSize - first.length;
  for (const b of walkChildren(tree)) {
    if (b.typ === "stco") {
      const nc = data.readUInt32BE(b.off + 12);
      for (let i = 0; i < nc; i++) {
        const v = data.readUInt32BE(b.off + 16 + i * 4);
        if (v >= moovOff + moovSize) {
          data.writeUInt32BE(v - delta, b.off + 16 + i * 4);
        }
      }
    }
  }
  return serialize(tree);
}
function decryptMp4Buffer(data, key) {
  const total = data.length;
  const top = parseBoxes(data, 0, total);
  const moov = top.find((b) => b.typ === "moov");
  if (!moov) throw new Error("no moov box found in MP4");
  function getBox(boxes, typ) {
    return (boxes || []).find((b) => b.typ === typ);
  }
  function* walkBoxes(boxes) {
    for (const b of boxes) {
      if (b.children) {
        for (const x of walkBoxes(b.children)) yield x;
      }
      yield b;
    }
  }
  const stbls = Array.from(walkBoxes(top)).filter((b) => b.typ === "stbl");
  const trackInfo = [];
  for (const stbl of stbls) {
    const stsz = getBox(stbl.children, "stsz");
    const stco = getBox(stbl.children, "stco");
    const stsc = getBox(stbl.children, "stsc");
    const senc = getBox(stbl.children, "senc");
    if (!stsz || !stco || !stsc) continue;
    const ss = data.readUInt32BE(stsz.off + 12);
    const n = data.readUInt32BE(stsz.off + 16);
    let sizes = [];
    if (ss === 0) {
      for (let i = 0; i < n; i++) {
        sizes.push(data.readUInt32BE(stsz.off + 20 + i * 4));
      }
    } else {
      sizes = new Array(n).fill(ss);
    }
    const nc = data.readUInt32BE(stco.off + 12);
    const chunkOffs = [];
    for (let i = 0; i < nc; i++) {
      chunkOffs.push(data.readUInt32BE(stco.off + 16 + i * 4));
    }
    const ns = data.readUInt32BE(stsc.off + 12);
    const stscTab = [];
    for (let i = 0; i < ns; i++) {
      stscTab.push([
        data.readUInt32BE(stsc.off + 16 + i * 12),
        data.readUInt32BE(stsc.off + 20 + i * 12),
        data.readUInt32BE(stsc.off + 24 + i * 12)
      ]);
    }
    const ivs = [];
    if (senc) {
      if (senc.hdr !== 8 || senc.size < 16) throw new Error("Unsupported CENC sample encryption layout");
      const sc = data.readUInt32BE(senc.off + 12);
      if (data.readUInt32BE(senc.off + 8) !== 0 || sc !== n || senc.size !== 16 + sc * 8) {
        throw new Error("Unsupported CENC sample encryption layout");
      }
      for (let i = 0; i < sc; i++) {
        ivs.push(data.subarray(senc.off + 16 + i * 8, senc.off + 24 + i * 8));
      }
    }
    const chunkSpc = {};
    for (let i = 0; i < stscTab.length; i++) {
      const fc = stscTab[i][0];
      const spc = stscTab[i][1];
      const nxt = i + 1 < stscTab.length ? stscTab[i + 1][0] : nc + 1;
      for (let ci = fc - 1; ci < nxt - 1; ci++) {
        chunkSpc[ci] = spc;
      }
    }
    const sampleOffs = [];
    let si = 0;
    for (let ci = 0; ci < nc; ci++) {
      let off2 = chunkOffs[ci];
      const spc = chunkSpc[ci] || 1;
      for (let s = 0; s < spc; s++) {
        if (si >= n) break;
        sampleOffs.push(off2);
        off2 += sizes[si];
        si++;
      }
    }
    trackInfo.push({ sizes, offs: sampleOffs, ivs, stco });
  }
  for (const ti of trackInfo) {
    for (let i = 0; i < ti.offs.length; i++) {
      const off2 = ti.offs[i];
      const sz = ti.sizes[i];
      if (off2 + sz > total) continue;
      if (i < ti.ivs.length) {
        const nonce = ti.ivs[i].subarray(0, 8);
        const cipher = data.subarray(off2, off2 + sz);
        const plain = decryptSample(key, nonce, cipher);
        plain.copy(data, off2);
      }
    }
  }
  const newMoov = rebuildMoov(data, moov.off, moov.size, top);
  const out = [];
  let off = 0;
  while (off < total) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString("latin1");
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = total - off;
    }
    if (typ === "moov") {
      out.push(newMoov);
    } else {
      out.push(data.subarray(off, off + size));
    }
    off += size;
  }
  return Buffer.concat(out);
}
function decryptMp4File(srcPath, dstPath, key) {
  const data = fs.readFileSync(srcPath);
  const finalBuf = decryptMp4Buffer(data, key);
  fs.writeFileSync(dstPath, finalBuf);
}
module.exports = {
  resolveSeriesId,
  fetchEpisodeList,
  fetchEpisodeListFromWeb,
  fetchPlayUrlSingle,
  fetchPlayUrlFromWeb,
  deriveKey,
  decryptMp4File,
  decryptMp4Buffer,
  VIDEO_REFERER,
  UA,
  WEB_UA,
  WEB_REFERER,
  markWebMediaFailure
};

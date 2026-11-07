'use strict';

// Serves the local Marzipano tool (tool/) together with a fresh build of this
// repository's Marzipano, so exported tours ship with this fork's viewer.
//
// Usage:
//   node scripts/tool.js [--port 8080] [--no-build]
//   npm run tool

var fs = require('fs');
var path = require('path');
var http = require('http');

var root = path.join(__dirname, '..');
var buildFile = path.join(root, 'build', 'marzipano.js');

var args = process.argv.slice(2);
var portIndex = args.indexOf('--port');
var port = portIndex >= 0 ? parseInt(args[portIndex + 1], 10) : 8080;
var skipBuild = args.indexOf('--no-build') >= 0;

var types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Only these top-level folders are served.
var servedDirs = ['tool', 'build', 'demos'];

function build(done) {
  var browserify = require('browserify');
  fs.mkdirSync(path.dirname(buildFile), { recursive: true });
  console.log('Building Marzipano from src/ ...');
  browserify(path.join(root, 'src', 'index.js'), {
    standalone: 'Marzipano'
  }).bundle(function(err, buf) {
    if (err) {
      return done(err);
    }
    fs.writeFileSync(buildFile, buf);
    console.log('Wrote ' + path.relative(root, buildFile) + ' (' + buf.length + ' bytes)');
    done(null);
  });
}

function serve() {
  var server = http.createServer(function(req, res) {
    var urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (e) {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (urlPath === '/') {
      res.writeHead(302, { Location: '/tool/' });
      return res.end();
    }
    var file = path.normalize(path.join(root, urlPath));
    var rel = path.relative(root, file);
    var top = rel.split(path.sep)[0];
    if (rel.startsWith('..') || path.isAbsolute(rel) || servedDirs.indexOf(top) < 0) {
      res.writeHead(404);
      return res.end('Not found');
    }
    fs.stat(file, function(err, stat) {
      if (!err && stat.isDirectory()) {
        if (!urlPath.endsWith('/')) {
          res.writeHead(302, { Location: urlPath + '/' });
          return res.end();
        }
        file = path.join(file, 'index.html');
      }
      fs.readFile(file, function(err, data) {
        if (err) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, {
          'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      });
    });
  });
  server.listen(port, '127.0.0.1', function() {
    console.log('Marzipano tool running at http://localhost:' + port + '/tool/');
  });
}

if (skipBuild && fs.existsSync(buildFile)) {
  serve();
} else {
  build(function(err) {
    if (err) {
      console.error(err.message || err);
      process.exit(1);
    }
    serve();
  });
}

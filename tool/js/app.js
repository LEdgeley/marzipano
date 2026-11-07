'use strict';

// Local Marzipano tool: turns panoramas into cube tiles in the browser and
// exports a viewer app in the same layout as the hosted Marzipano Tool
// (app-files/{index.html,index.js,data.js,style.css,img,vendor,tiles}).

(function() {
  var Marzipano = window.Marzipano;

  var PREVIEW_LEVEL = { tileSize: 256, size: 256, fallbackOnly: true };
  var FACES = 'fudlrb';
  var CUBE_FACE_RE = /^(.*)_([udfblr])\.[^.]+$/i;
  var TEMPLATE_FILES = [
    'app-files/index.js',
    'app-files/style.css',
    'app-files/vendor/reset.min.css',
    'app-files/img/play.png',
    'app-files/img/pause.png',
    'app-files/img/expand.png',
    'app-files/img/collapse.png',
    'app-files/img/link.png',
    'app-files/img/info.png',
    'app-files/img/close.png',
    'app-files/img/up.png',
    'app-files/img/down.png',
    'app-files/img/left.png',
    'app-files/img/right.png',
    'app-files/img/plus.png',
    'app-files/img/minus.png',
    'app-files/img/fullscreen.png',
    'app-files/img/windowed.png',
    'README.txt',
    'LICENSE.txt'
  ];
  var IMG = 'template/app-files/img/';

  var $ = function(sel) { return document.querySelector(sel); };

  // ---- State ---------------------------------------------------------------

  var nextUid = 1;
  var scenes = [];
  var selected = null;
  var pendingProject = null; // project data waiting for matching files
  var settings = {
    mouseViewMode: 'drag',
    autorotateEnabled: true,
    fullscreenButton: true,
    viewControlButtons: false
  };

  function slug(s) {
    return s.replace(/ /g, '-').replace(/[^A-Za-z0-9\-_]/g, '').toLowerCase();
  }

  function exportId(scene) {
    return scenes.indexOf(scene) + '-' + slug(scene.name);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function findScene(uid) {
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i].uid === uid) { return scenes[i]; }
    }
    return null;
  }

  // ---- Viewer --------------------------------------------------------------

  var viewer = new Marzipano.Viewer($('#pano'), {
    controls: { mouseViewMode: settings.mouseViewMode }
  });

  function applyMouseViewMode() {
    var controls = viewer.controls();
    if (settings.mouseViewMode === 'qtvr') {
      controls.disableMethod('mouseViewDrag');
      controls.enableMethod('mouseViewQtvr');
    } else {
      controls.disableMethod('mouseViewQtvr');
      controls.enableMethod('mouseViewDrag');
    }
  }

  function tileKey(z, f, y, x) { return z + '/' + f + '/' + y + '/' + x; }

  function ensureMarzipanoScene(scene) {
    if (scene.mz) { return scene.mz; }
    var previewUrl = URL.createObjectURL(scene.preview);
    scene.objectUrls.push(previewUrl);
    var source = new Marzipano.ImageUrlSource(function(tile) {
      if (tile.z === 0) {
        var y = 'bdflru'.indexOf(tile.face) / 6;
        return { url: previewUrl, rect: { x: 0, y: y, width: 1, height: 1 / 6 } };
      }
      var key = tileKey(tile.z, tile.face, tile.y, tile.x);
      var url = scene.tileUrls.get(key);
      if (!url) {
        url = URL.createObjectURL(scene.tiles.get(key));
        scene.tileUrls.set(key, url);
        scene.objectUrls.push(url);
      }
      return { url: url };
    });
    var geometry = new Marzipano.CubeGeometry(scene.allLevels());
    var limiter = Marzipano.RectilinearView.limit.traditional(scene.dataFaceSize(), 100 * Math.PI / 180, 120 * Math.PI / 180);
    var view = new Marzipano.RectilinearView(scene.initialViewParameters, limiter);
    var mzScene = viewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true });
    scene.mz = { scene: mzScene, view: view, hotspots: [] };
    return scene.mz;
  }

  function showScene(scene) {
    selected = scene;
    renderSceneList();
    var status = $('#sceneStatus');
    if (!scene || scene.status !== 'ready') {
      document.body.classList.toggle('has-scene', false);
      status.textContent = scene ? (scene.status === 'error' ? 'Failed: ' + scene.error : 'Processing ' + scene.name + '…') : '';
      $('#empty').style.display = scene ? 'none' : '';
      return;
    }
    status.textContent = '';
    $('#empty').style.display = '';
    document.body.classList.add('has-scene');
    var mz = ensureMarzipanoScene(scene);
    mz.view.setParameters(scene.initialViewParameters);
    mz.scene.switchTo({ transitionDuration: 300 });
    renderHotspots(scene);
  }

  // ---- Hotspot editing -----------------------------------------------------

  var STOP_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel',
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'wheel'];

  function stopPropagation(el) {
    STOP_EVENTS.forEach(function(name) {
      el.addEventListener(name, function(e) { e.stopPropagation(); });
    });
  }

  function makeDraggable(handle, wrapper, scene, data, getHotspot) {
    var start = null;
    handle.addEventListener('pointerdown', function(e) {
      start = { x: e.clientX, y: e.clientY, moved: false };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function(e) {
      if (!start) { return; }
      if (!start.moved && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) { return; }
      start.moved = true;
      var rect = $('#pano').getBoundingClientRect();
      var coords = scene.mz.view.screenToCoordinates({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (coords) {
        data.yaw = coords.yaw;
        data.pitch = coords.pitch;
        getHotspot().setPosition({ yaw: data.yaw, pitch: data.pitch });
      }
    });
    handle.addEventListener('pointerup', function() {
      if (start && !start.moved) {
        wrapper.classList.toggle('collapsed');
      }
      start = null;
    });
  }

  function infoHotspotElement(scene, data) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ed-hotspot collapsed';
    wrapper.innerHTML =
      '<div class="handle" title="Drag to move, click to edit"><img src="' + IMG + 'info.png" alt=""></div>' +
      '<div class="panel">' +
        '<input type="text" class="title" placeholder="Title">' +
        '<textarea class="text" placeholder="Text (HTML allowed)"></textarea>' +
        '<div class="row"><button type="button" class="done">Done</button>' +
        '<button type="button" class="danger remove">Delete</button></div>' +
      '</div>';
    var title = wrapper.querySelector('.title');
    var text = wrapper.querySelector('.text');
    title.value = data.title;
    text.value = data.text;
    title.addEventListener('input', function() { data.title = title.value; });
    text.addEventListener('input', function() { data.text = text.value; });
    wrapper.querySelector('.done').addEventListener('click', function() { wrapper.classList.add('collapsed'); });
    wrapper.querySelector('.remove').addEventListener('click', function() {
      if (confirm('Delete this hotspot?')) {
        scene.infoHotspots.splice(scene.infoHotspots.indexOf(data), 1);
        renderHotspots(scene);
      }
    });
    return wrapper;
  }

  function linkHotspotElement(scene, data) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ed-hotspot collapsed';
    wrapper.innerHTML =
      '<div class="handle" title="Drag to move, click to edit"><img src="' + IMG + 'link.png" alt=""></div>' +
      '<div class="panel">' +
        '<label>Target <select class="target"></select></label>' +
        '<div class="row">' +
          '<button type="button" class="rotl" title="Rotate left">⟲</button>' +
          '<button type="button" class="rotr" title="Rotate right">⟳</button>' +
          '<button type="button" class="go">Go to target</button>' +
          '<button type="button" class="danger remove">Delete</button>' +
        '</div>' +
      '</div>';
    var img = wrapper.querySelector('.handle img');
    var select = wrapper.querySelector('.target');
    function updateRotation() { img.style.transform = 'rotate(' + data.rotation + 'rad)'; }
    updateRotation();
    scenes.forEach(function(s) {
      if (s === scene) { return; }
      var opt = document.createElement('option');
      opt.value = s.uid;
      opt.textContent = s.name;
      if (s.uid === data.target) { opt.selected = true; }
      select.appendChild(opt);
    });
    if (!findScene(data.target) || data.target === scene.uid) {
      data.target = select.options.length ? +select.options[0].value : null;
    }
    select.addEventListener('change', function() { data.target = +select.value; });
    function rotate(delta) {
      var r = data.rotation + delta;
      var full = 2 * Math.PI;
      data.rotation = ((r % full) + full) % full;
      updateRotation();
    }
    wrapper.querySelector('.rotl').addEventListener('click', function() { rotate(-Math.PI / 4); });
    wrapper.querySelector('.rotr').addEventListener('click', function() { rotate(Math.PI / 4); });
    wrapper.querySelector('.go').addEventListener('click', function() {
      var t = findScene(data.target);
      if (t) { showScene(t); }
    });
    wrapper.querySelector('.remove').addEventListener('click', function() {
      if (confirm('Delete this hotspot?')) {
        scene.linkHotspots.splice(scene.linkHotspots.indexOf(data), 1);
        renderHotspots(scene);
      }
    });
    return wrapper;
  }

  function renderHotspots(scene) {
    if (!scene.mz) { return; }
    var container = scene.mz.scene.hotspotContainer();
    scene.mz.hotspots.forEach(function(h) { container.destroyHotspot(h); });
    scene.mz.hotspots = [];
    function add(data, el) {
      stopPropagation(el);
      var hotspot = container.createHotspot(el, { yaw: data.yaw, pitch: data.pitch });
      makeDraggable(el.querySelector('.handle'), el, scene, data, function() { return hotspot; });
      scene.mz.hotspots.push(hotspot);
      return el;
    }
    scene.linkHotspots.forEach(function(d) { add(d, linkHotspotElement(scene, d)); });
    scene.infoHotspots.forEach(function(d) { add(d, infoHotspotElement(scene, d)); });
  }

  function viewCenter() {
    var p = selected.mz.view.parameters();
    return { yaw: p.yaw, pitch: p.pitch };
  }

  $('#setInitialView').addEventListener('click', function() {
    var p = selected.mz.view.parameters();
    selected.initialViewParameters = { yaw: p.yaw, pitch: p.pitch, fov: p.fov };
    toast('Initial view set');
  });

  $('#addInfo').addEventListener('click', function() {
    var c = viewCenter();
    var data = { yaw: c.yaw, pitch: c.pitch, title: 'Title', text: 'Text' };
    selected.infoHotspots.push(data);
    renderHotspots(selected);
    openLastEditor();
  });

  $('#addLink').addEventListener('click', function() {
    if (scenes.length < 2) {
      toast('Add another panorama to link to', true);
      return;
    }
    var c = viewCenter();
    var target = scenes[(scenes.indexOf(selected) + 1) % scenes.length];
    selected.linkHotspots.push({ yaw: c.yaw, pitch: c.pitch, rotation: 0, target: target.uid });
    renderHotspots(selected);
  });

  function openLastEditor() {
    var hs = selected.mz.hotspots;
    if (hs.length) {
      hs[hs.length - 1].domElement().classList.remove('collapsed');
    }
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { el.classList.remove('show'); }, 1800);
  }

  // ---- Scene list ----------------------------------------------------------

  function renderSceneList() {
    var list = $('#sceneList');
    list.innerHTML = '';
    scenes.forEach(function(scene, i) {
      var li = document.createElement('li');
      li.className = scene.status + (scene === selected ? ' selected' : '');
      li.innerHTML =
        '<div class="top">' +
          '<input class="name" type="text" aria-label="Panorama name">' +
          '<button type="button" class="icon up" title="Move up">↑</button>' +
          '<button type="button" class="icon down" title="Move down">↓</button>' +
          '<button type="button" class="icon remove" title="Remove">✕</button>' +
        '</div>' +
        '<div class="meta"><span class="info"></span><span class="state"></span></div>' +
        '<div class="bar"><div></div></div>';
      var name = li.querySelector('.name');
      name.value = scene.name;
      name.addEventListener('input', function() { scene.name = name.value || 'untitled'; });
      name.addEventListener('click', function(e) { e.stopPropagation(); });
      li.querySelector('.info').textContent = scene.kind === 'cube' ? 'cube faces' : (scene.width ? scene.width + '×' + scene.height : 'equirectangular');
      li.querySelector('.state').textContent = stateText(scene);
      li.querySelector('.bar > div').style.width = Math.round(scene.progress * 100) + '%';
      li.querySelector('.up').disabled = i === 0;
      li.querySelector('.down').disabled = i === scenes.length - 1;
      li.querySelector('.up').addEventListener('click', function(e) { e.stopPropagation(); move(scene, -1); });
      li.querySelector('.down').addEventListener('click', function(e) { e.stopPropagation(); move(scene, 1); });
      li.querySelector('.remove').addEventListener('click', function(e) { e.stopPropagation(); removeScene(scene); });
      li.addEventListener('click', function() { showScene(scene); });
      scene.listItem = li;
      list.appendChild(li);
    });
  }

  function stateText(scene) {
    if (scene.status === 'ready') {
      return 'face ' + scene.faceSize + 'px · ' + scene.tiles.size + ' tiles';
    }
    if (scene.status === 'error') { return scene.error; }
    if (scene.status === 'queued') { return 'queued'; }
    return scene.stage + ' ' + Math.round(scene.progress * 100) + '%';
  }

  function updateSceneProgress(scene) {
    var li = scene.listItem;
    if (!li) { return; }
    li.className = scene.status + (scene === selected ? ' selected' : '');
    li.querySelector('.state').textContent = stateText(scene);
    li.querySelector('.bar > div').style.width = Math.round(scene.progress * 100) + '%';
  }

  function move(scene, delta) {
    var i = scenes.indexOf(scene);
    var j = i + delta;
    if (j < 0 || j >= scenes.length) { return; }
    scenes.splice(i, 1);
    scenes.splice(j, 0, scene);
    renderSceneList();
  }

  function removeScene(scene) {
    if (!confirm('Remove "' + scene.name + '"?')) { return; }
    if (scene.worker) { scene.worker.terminate(); }
    if (scene.mz) { viewer.destroyScene(scene.mz.scene); }
    scene.objectUrls.forEach(function(u) { URL.revokeObjectURL(u); });
    scenes.splice(scenes.indexOf(scene), 1);
    scenes.forEach(function(s) {
      s.linkHotspots = s.linkHotspots.filter(function(h) { return h.target !== scene.uid; });
    });
    if (selected === scene) {
      showScene(scenes[0] || null);
    } else {
      renderSceneList();
      if (selected) { renderHotspots(selected); }
    }
    processQueue();
  }

  // ---- Adding panoramas and processing -------------------------------------

  function Scene(kind, name, fileName, files) {
    this.uid = nextUid++;
    this.kind = kind;
    this.name = name;
    this.fileName = fileName;
    this.files = files;
    this.status = 'queued';
    this.stage = '';
    this.progress = 0;
    this.error = null;
    this.levels = null;
    this.faceSize = null;
    this.tiles = new Map();
    this.tileUrls = new Map();
    this.objectUrls = [];
    this.preview = null;
    this.initialViewParameters = { yaw: 0, pitch: 0, fov: Math.PI / 2 };
    this.linkHotspots = [];
    this.infoHotspots = [];
    this.mz = null;
  }
  Scene.prototype.allLevels = function() {
    return [PREVIEW_LEVEL].concat(this.levels);
  };
  // As in the hosted tool: the face size reported to the viewer never exceeds
  // the largest level.
  Scene.prototype.dataFaceSize = function() {
    return Math.min(this.faceSize, this.levels[this.levels.length - 1].size);
  };

  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

  function addFiles(fileList) {
    var files = Array.prototype.filter.call(fileList, function(f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|avif|bmp|gif|tiff?)$/i.test(f.name);
    });
    var skipped = fileList.length - files.length;
    var groups = {};
    var singles = [];
    files.forEach(function(f) {
      var m = f.name.match(CUBE_FACE_RE);
      if (m) {
        var key = m[1];
        (groups[key] = groups[key] || {})[m[2].toLowerCase()] = f;
      } else {
        singles.push(f);
      }
    });
    var added = [];
    Object.keys(groups).forEach(function(key) {
      var g = groups[key];
      if (FACES.split('').every(function(face) { return g[face]; })) {
        added.push(new Scene('cube', key, key, g));
      } else {
        // Not a full set of faces: treat each as an equirectangular image.
        Object.keys(g).forEach(function(face) { singles.push(g[face]); });
      }
    });
    singles.forEach(function(f) {
      added.push(new Scene('equirect', baseName(f.name), f.name, f));
    });
    added.forEach(function(scene) {
      scenes.push(scene);
      applyPendingProject(scene);
    });
    if (pendingProject) { sortByProject(); }
    if (skipped > 0) {
      toast(skipped + ' file(s) skipped (not images)', true);
    }
    renderSceneList();
    if (!selected && added.length) {
      showScene(added[0]);
    }
    processQueue();
  }

  var processing = null;
  function processQueue() {
    if (processing) { return; }
    var scene = scenes.find(function(s) { return s.status === 'queued'; });
    if (!scene) { return; }
    processing = scene;
    scene.status = 'processing';
    scene.stage = 'starting';
    var worker = new Worker('js/process.worker.js');
    scene.worker = worker;
    var quality = Math.max(0.5, Math.min(1, (+$('#quality').value || 85) / 100));
    worker.onmessage = function(e) {
      var m = e.data;
      if (m.type === 'size') {
        scene.width = m.width;
        scene.height = m.height;
        var info = scene.listItem && scene.listItem.querySelector('.info');
        if (info && scene.kind !== 'cube') { info.textContent = m.width + '×' + m.height; }
      } else if (m.type === 'levels') {
        scene.levels = m.levels;
        scene.faceSize = m.faceSize;
      } else if (m.type === 'tile') {
        scene.tiles.set(tileKey(m.z, m.face, m.y, m.x), m.blob);
      } else if (m.type === 'preview') {
        scene.preview = m.blob;
      } else if (m.type === 'progress') {
        scene.stage = m.stage;
        scene.progress = m.total ? m.done / m.total : 0;
        updateSceneProgress(scene);
      } else if (m.type === 'done') {
        finish('ready');
      } else if (m.type === 'error') {
        scene.error = m.message;
        finish('error');
      }
    };
    worker.onerror = function(e) {
      scene.error = e.message || 'Worker failed';
      finish('error');
    };
    function finish(status) {
      worker.terminate();
      scene.worker = null;
      scene.status = status;
      scene.progress = status === 'ready' ? 1 : scene.progress;
      processing = null;
      renderSceneList();
      if (selected === scene) { showScene(scene); }
      processQueue();
    }
    worker.postMessage(scene.kind === 'cube'
      ? { kind: 'cube', files: scene.files, quality: quality }
      : { kind: 'equirect', file: scene.files, quality: quality });
    renderSceneList();
  }

  $('#fileInput').addEventListener('change', function(e) {
    addFiles(e.target.files);
    e.target.value = '';
  });

  var dragDepth = 0;
  window.addEventListener('dragenter', function(e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) {
      dragDepth++;
      document.body.classList.add('dragging');
    }
  });
  window.addEventListener('dragleave', function() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', function(e) { e.preventDefault(); });
  window.addEventListener('drop', function(e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length) { addFiles(e.dataTransfer.files); }
  });

  // ---- Settings ------------------------------------------------------------

  function readSettings() {
    settings.mouseViewMode = $('input[name=mouseViewMode]:checked').value;
    settings.autorotateEnabled = $('#autorotateEnabled').checked;
    settings.viewControlButtons = $('#viewControlButtons').checked;
    settings.fullscreenButton = $('#fullscreenButton').checked;
  }
  function writeSettings() {
    $('input[name=mouseViewMode][value=' + (settings.mouseViewMode === 'qtvr' ? 'qtvr' : 'drag') + ']').checked = true;
    $('#autorotateEnabled').checked = !!settings.autorotateEnabled;
    $('#viewControlButtons').checked = !!settings.viewControlButtons;
    $('#fullscreenButton').checked = !!settings.fullscreenButton;
    applyMouseViewMode();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#sidebar input[name=mouseViewMode], #autorotateEnabled, #viewControlButtons, #fullscreenButton'), function(el) {
    el.addEventListener('change', function() {
      readSettings();
      applyMouseViewMode();
    });
  });

  // ---- Project save / load -------------------------------------------------

  function projectData() {
    readSettings();
    return {
      format: 'marzipano-local-tool-project',
      version: 1,
      name: $('#tourName').value,
      settings: Object.assign({}, settings),
      scenes: scenes.map(function(s) {
        return {
          fileName: s.fileName,
          name: s.name,
          initialViewParameters: s.initialViewParameters,
          linkHotspots: s.linkHotspots.map(function(h) {
            var t = findScene(h.target);
            return { yaw: h.yaw, pitch: h.pitch, rotation: h.rotation, target: t ? t.fileName : null };
          }),
          infoHotspots: s.infoHotspots.map(function(h) {
            return { yaw: h.yaw, pitch: h.pitch, title: h.title, text: h.text };
          })
        };
      })
    };
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
  }

  $('#saveProject').addEventListener('click', function() {
    var json = JSON.stringify(projectData(), null, 2);
    download(new Blob([json], { type: 'application/json' }), (slug($('#tourName').value) || 'tour') + '.project.json');
  });

  $('#projectInput').addEventListener('change', function(e) {
    var file = e.target.files[0];
    e.target.value = '';
    if (!file) { return; }
    file.text().then(function(text) {
      var p = JSON.parse(text);
      if (p.format !== 'marzipano-local-tool-project') {
        throw new Error('Not a project file');
      }
      pendingProject = p;
      $('#tourName').value = p.name || 'Tour';
      settings = Object.assign(settings, p.settings || {});
      writeSettings();
      scenes.forEach(applyPendingProject);
      sortByProject();
      // Link targets may only resolve once every scene has its data.
      scenes.forEach(resolvePendingLinks);
      renderSceneList();
      if (selected) { showScene(selected); }
      var missing = p.scenes.filter(function(ps) {
        return !scenes.some(function(s) { return s.fileName === ps.fileName; });
      }).map(function(ps) { return ps.fileName; });
      toast(missing.length ? 'Project loaded. Now add: ' + missing.join(', ') : 'Project loaded');
    }).catch(function(err) { toast('Could not load project: ' + err.message, true); });
  });

  function projectSceneFor(scene) {
    if (!pendingProject) { return null; }
    for (var i = 0; i < pendingProject.scenes.length; i++) {
      if (pendingProject.scenes[i].fileName === scene.fileName) { return pendingProject.scenes[i]; }
    }
    return null;
  }

  function applyPendingProject(scene) {
    var ps = projectSceneFor(scene);
    if (!ps) { return; }
    scene.name = ps.name;
    scene.initialViewParameters = Object.assign({}, ps.initialViewParameters);
    scene.infoHotspots = ps.infoHotspots.map(function(h) { return Object.assign({}, h); });
    scene.pendingLinks = ps.linkHotspots;
    scene.linkHotspots = [];
    scenes.forEach(resolvePendingLinks);
  }

  // Keeps unresolved links until their target scene has been added.
  function resolvePendingLinks(scene) {
    if (!scene.pendingLinks) { return; }
    scene.pendingLinks = scene.pendingLinks.filter(function(h) {
      var target = scenes.find(function(s) { return s.fileName === h.target; });
      if (!target) { return true; }
      scene.linkHotspots.push({ yaw: h.yaw, pitch: h.pitch, rotation: h.rotation, target: target.uid });
      return false;
    });
    if (scene.mz) { renderHotspots(scene); }
  }

  function sortByProject() {
    var order = pendingProject.scenes.map(function(s) { return s.fileName; });
    var rank = function(s) {
      var i = order.indexOf(s.fileName);
      return i < 0 ? order.length + scenes.indexOf(s) : i;
    };
    var ranked = scenes.map(function(s) { return { s: s, r: rank(s) }; });
    ranked.sort(function(a, b) { return a.r - b.r; });
    scenes = ranked.map(function(x) { return x.s; });
  }

  // ---- Export --------------------------------------------------------------

  function tourData() {
    readSettings();
    var ready = scenes.filter(function(s) { return s.status === 'ready'; });
    return {
      scenes: ready.map(function(s) {
        return {
          id: exportId(s),
          name: s.name,
          levels: s.allLevels(),
          faceSize: s.dataFaceSize(),
          initialViewParameters: s.initialViewParameters,
          linkHotspots: s.linkHotspots.filter(function(h) {
            var t = findScene(h.target);
            return t && t.status === 'ready';
          }).map(function(h) {
            return { yaw: h.yaw, pitch: h.pitch, rotation: h.rotation, target: exportId(findScene(h.target)) };
          }),
          infoHotspots: s.infoHotspots.map(function(h) {
            return { yaw: h.yaw, pitch: h.pitch, title: h.title, text: h.text };
          })
        };
      }),
      name: $('#tourName').value,
      settings: Object.assign({}, settings)
    };
  }

  function dataJs(data) {
    var json = JSON.stringify(data, null, 2)
      .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
      .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
    return 'var APP_DATA = ' + json + ';\n';
  }

  function indexHtml(data) {
    var classes = [data.scenes.length > 1 ? 'multiple-scenes' : 'single-scene'];
    if (data.settings.viewControlButtons) { classes.push('view-control-buttons'); }
    var sceneLinks = data.scenes.map(function(s) {
      return '    <a href="javascript:void(0)" class="scene" data-id="' + escapeHtml(s.id) + '">\n' +
             '      <li class="text">' + escapeHtml(s.name) + '</li>\n' +
             '    </a>';
    }).join('\n');
    return [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '<title>' + escapeHtml(data.name) + '</title>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="target-densitydpi=device-dpi, width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, minimal-ui" />',
      '<style> @-ms-viewport { width: device-width; } </style>',
      '<link rel="stylesheet" href="vendor/reset.min.css">',
      '<link rel="stylesheet" href="style.css">',
      '</head>',
      '<body class="' + classes.join(' ') + '">',
      '',
      '<div id="pano"></div>',
      '',
      '<div id="sceneList">',
      '  <ul class="scenes">',
      sceneLinks,
      '  </ul>',
      '</div>',
      '',
      '<div id="titleBar">',
      '  <h1 class="sceneName"></h1>',
      '</div>',
      '',
      '<a href="javascript:void(0)" id="autorotateToggle">',
      '  <img class="icon off" src="img/play.png">',
      '  <img class="icon on" src="img/pause.png">',
      '</a>',
      '',
      '<a href="javascript:void(0)" id="fullscreenToggle">',
      '  <img class="icon off" src="img/fullscreen.png">',
      '  <img class="icon on" src="img/windowed.png">',
      '</a>',
      '',
      '<a href="javascript:void(0)" id="sceneListToggle">',
      '  <img class="icon off" src="img/expand.png">',
      '  <img class="icon on" src="img/collapse.png">',
      '</a>',
      '',
      '<a href="javascript:void(0)" id="viewUp" class="viewControlButton viewControlButton-1"><img class="icon" src="img/up.png"></a>',
      '<a href="javascript:void(0)" id="viewDown" class="viewControlButton viewControlButton-2"><img class="icon" src="img/down.png"></a>',
      '<a href="javascript:void(0)" id="viewLeft" class="viewControlButton viewControlButton-3"><img class="icon" src="img/left.png"></a>',
      '<a href="javascript:void(0)" id="viewRight" class="viewControlButton viewControlButton-4"><img class="icon" src="img/right.png"></a>',
      '<a href="javascript:void(0)" id="viewIn" class="viewControlButton viewControlButton-5"><img class="icon" src="img/plus.png"></a>',
      '<a href="javascript:void(0)" id="viewOut" class="viewControlButton viewControlButton-6"><img class="icon" src="img/minus.png"></a>',
      '',
      '<script src="vendor/marzipano.js"></script>',
      '<script src="data.js"></script>',
      '<script src="index.js"></script>',
      '',
      '</body>',
      '</html>',
      ''
    ].join('\n');
  }

  // Calls add(path, data) for every file of the exported tour.
  async function writeTour(add, status) {
    var data = tourData();
    if (!data.scenes.length) {
      throw new Error('No processed panoramas to export');
    }
    status('Adding app files…');
    await add('app-files/data.js', dataJs(data));
    await add('app-files/index.html', indexHtml(data));
    for (var i = 0; i < TEMPLATE_FILES.length; i++) {
      var res = await fetch('template/' + TEMPLATE_FILES[i]);
      if (!res.ok) { throw new Error('Missing template file ' + TEMPLATE_FILES[i]); }
      await add(TEMPLATE_FILES[i], await res.blob());
    }
    var mzRes = await fetch('../build/marzipano.js');
    if (!mzRes.ok) { throw new Error('build/marzipano.js not found; run npm run tool'); }
    await add('app-files/vendor/marzipano.js', await mzRes.blob());

    var ready = scenes.filter(function(s) { return s.status === 'ready'; });
    var total = ready.reduce(function(n, s) { return n + s.tiles.size + 1; }, 0);
    var done = 0;
    for (var j = 0; j < ready.length; j++) {
      var scene = ready[j];
      var dir = 'app-files/tiles/' + exportId(scene) + '/';
      await add(dir + 'preview.jpg', scene.preview);
      done++;
      var keys = Array.from(scene.tiles.keys());
      for (var k = 0; k < keys.length; k++) {
        await add(dir + keys[k] + '.jpg', scene.tiles.get(keys[k]));
        done++;
        if (done % 50 === 0) {
          status('Writing tiles ' + done + ' / ' + total);
        }
      }
    }
  }

  function checkExportable() {
    if (scenes.some(function(s) { return s.status === 'queued' || s.status === 'processing'; })) {
      toast('Wait for processing to finish', true);
      return false;
    }
    return true;
  }

  function setExportBusy(busy) {
    $('#exportZip').disabled = busy;
    $('#exportFolder').disabled = busy;
  }

  function exportStatus(msg) { $('#exportStatus').textContent = msg; }

  $('#exportZip').addEventListener('click', async function() {
    if (!checkExportable()) { return; }
    setExportBusy(true);
    try {
      var zip = new window.ZipWriter();
      await writeTour(function(path, data) { return zip.add(path, data); }, exportStatus);
      exportStatus('Creating ZIP…');
      download(zip.finish(), (slug($('#tourName').value) || 'tour') + '.zip');
      exportStatus('Exported ZIP.');
    } catch (err) {
      exportStatus('Export failed: ' + err.message);
    } finally {
      setExportBusy(false);
    }
  });

  if (!window.showDirectoryPicker) {
    $('#exportFolder').disabled = true;
    $('#exportFolder').title = 'Needs a Chromium-based browser (Chrome, Edge)';
  }
  $('#exportFolder').addEventListener('click', async function() {
    if (!checkExportable()) { return; }
    var root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      return; // cancelled
    }
    setExportBusy(true);
    var dirCache = new Map();
    async function getDir(parts) {
      var key = parts.join('/');
      if (dirCache.has(key)) { return dirCache.get(key); }
      var parent = parts.length ? await getDir(parts.slice(0, -1)) : root;
      var dir = parts.length ? await parent.getDirectoryHandle(parts[parts.length - 1], { create: true }) : root;
      dirCache.set(key, dir);
      return dir;
    }
    try {
      await writeTour(async function(path, data) {
        var parts = path.split('/');
        var name = parts.pop();
        var dir = await getDir(parts);
        var handle = await dir.getFileHandle(name, { create: true });
        var writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
      }, exportStatus);
      exportStatus('Exported to folder "' + root.name + '".');
    } catch (err) {
      exportStatus('Export failed: ' + err.message);
    } finally {
      setExportBusy(false);
    }
  });

  window.addEventListener('beforeunload', function(e) {
    if (scenes.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Exposed for debugging and automated checks.
  window.marzipanoTool = { scenes: function() { return scenes; }, tourData: tourData, addFiles: addFiles };

  renderSceneList();
})();

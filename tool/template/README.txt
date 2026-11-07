This tour was exported by the local Marzipano tool.

The viewer lives in app-files/. Because browsers block tile loading from
file:// pages, serve that folder over HTTP to view it, for example:

    npx http-server app-files
    (or)  python -m http.server --directory app-files

Files:
  app-files/index.html        page and scene list
  app-files/index.js          viewer logic (hotspots, autorotate, controls)
  app-files/data.js           scenes, levels, initial views and hotspots (APP_DATA)
  app-files/style.css         viewer styles
  app-files/tiles/<scene>/    preview.jpg plus {z}/{f}/{y}/{x}.jpg cube tiles
  app-files/vendor/marzipano.js  the Marzipano build the tool was running

To use a different Marzipano build, replace app-files/vendor/marzipano.js.

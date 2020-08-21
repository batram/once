const { app, BrowserWindow } = require('electron')
const https = require('https');

require('electron-reload')(__dirname);

function createWindow () {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true
    }
  })

  win.webContents.session.webRequest.onHeadersReceived({ urls: [ "*://*/*" ] },
    (d, c)=>{
      if(d.responseHeaders['X-Frame-Options']){
        delete d.responseHeaders['X-Frame-Options']
      } else if(d.responseHeaders['x-frame-options']) {
        delete d.responseHeaders['x-frame-options']
      } else if(d.responseHeaders['content-security-policy']) {
        delete d.responseHeaders['content-security-policy']
      }
      delete d.responseHeaders['content-security-policy']
      delete d.responseHeaders['Set-Cookie']
      delete d.responseHeaders['Content-Security-Policy']
      delete d.responseHeaders['X-Content-Type-Options']
      delete d.responseHeaders['X-XSS-Protection']
      console.log(d);

      c({cancel: false, responseHeaders: d.responseHeaders})
    }
  )



  // and load the index.html of the app.
  win.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()
});
// LinuxServer KasmVNC Client

//// Env variables ////
var CUSTOM_USER = process.env.CUSTOM_USER || 'abc';
var PASSWORD = process.env.PASSWORD || 'abc';
var SUBFOLDER = process.env.SUBFOLDER || '/';
var TITLE = process.env.TITLE || 'KasmVNC Client';
var FM_HOME = process.env.FM_HOME || '/config/Downloads';

//// Application Variables ////
var socketIO = require('socket.io');
var express = require('express');
var ejs = require('ejs');
var app = require('express')();
var http = require('http').Server(app);
var bodyParser = require('body-parser');
var baseRouter = express.Router();
var fsw = require('fs').promises;
var fs = require('fs');
var chokidar = require('chokidar'); // Adicionada a biblioteca chokidar

// Audio init
var audioEnabled = true;
var PulseAudio = require('pulseaudio2');
var pulse = new PulseAudio();
pulse.on('error', function(error) {
  console.log(error);
  audioEnabled = false;
  console.log('Kclient was unable to init audio, it is possible your host lacks support!!!!');
});

//// Server Paths Main ////
app.engine('html', require('ejs').renderFile);
app.engine('json', require('ejs').renderFile);
baseRouter.use('/public', express.static(__dirname + '/public'));
baseRouter.use('/vnc', express.static("/usr/share/kasmvnc/www/"));
baseRouter.get('/', function (req, res) {
  res.render(__dirname + '/public/index.html', {title: TITLE});
});
baseRouter.get('/favicon.ico', function (req, res) {
  res.sendFile(__dirname + '/public/favicon.ico');
});
baseRouter.get('/manifest.json', function (req, res) {
  res.render(__dirname + '/public/manifest.json', {title: TITLE});
});

//// Web File Browser ////
// Send landing page 
baseRouter.get('/files', function (req, res) {
  res.sendFile( __dirname + '/public/filebrowser.html');
});
// Websocket comms //
io = socketIO(http, {path: SUBFOLDER + 'files/socket.io',maxHttpBufferSize: 200000000});
io.on('connection', async function (socket) {
  let id = socket.id;

  //// Functions ////

  // Open default location
  async function checkAuth(password) {
    getFiles(FM_HOME);
  }

  // Emit to user
  function send(command, data) {
    io.sockets.to(id).emit(command, data);
  }

  // Get file list for directory
  async function getFiles(directory) {
    try { 
      let items = await fsw.readdir(directory);
      if (items.length > 0) {
        let dirs = [];
        let files = [];
        for await (let item of items) {
          let fullPath = directory + '/' + item;
          if (fs.lstatSync(fullPath).isDirectory()) {
            dirs.push(item);
          } else {
            files.push(item);
          }
        }
        send('renderfiles', [dirs, files, directory]);
      } else {
        send('renderfiles', [[], [], directory]);
      }
    } catch (error) {
      send('renderfiles', [[], [], directory]);
    }
  }

  // Send file to client
  async function downloadFile(file) {
    let fileName = file.split('/').slice(-1)[0];
    let data = await fsw.readFile(file);
    send('sendfile', [data, fileName]);
  }

  // Write client sent file
  async function uploadFile(res) {
    let directory = res[0];
    let filePath = res[1];
    let data = res[2];
    let render = res[3];
    let dirArr = filePath.split('/');
    let folder = filePath.replace(dirArr[dirArr.length - 1], '')
    await fsw.mkdir(folder, { recursive: true });
    await fsw.writeFile(filePath, Buffer.from(data));
    if (render) {
      getFiles(directory);
    }
  }

  // Delete files
  async function deleteFiles(res) {
    let item = res[0];
    let directory = res[1];
    item = item.replace("|","'");
    if (fs.lstatSync(item).isDirectory()) {
      await fsw.rm(item, {recursive: true});
    } else {
      await fsw.unlink(item);
    }
    getFiles(directory);
  }

  // Create a folder
  async function createFolder(res) {
    let dir = res[0];
    let directory = res[1];
    if (!fs.existsSync(dir)){
      await fsw.mkdir(dir);
    }
    getFiles(directory);
  }

// Watch for new files in FM_HOME directory
const watcher = chokidar.watch(FM_HOME);
let latestFile = null;

watcher.on('add', async function (filePath) {
  // console.log('Novo arquivo:', filePath);

  if (isFileNew(filePath) && !isPartFile(filePath)) {
    // Aguarda 2 segundos antes de fazer o download
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verifica se há alterações adicionais no tamanho do arquivo
    let previousSize = fs.statSync(filePath).size;
    let newSize = previousSize;
    let downloadComplete = false;

    while (!downloadComplete) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      newSize = fs.statSync(filePath).size;
      // console.log('Tamanho do arquivo:', newSize, filePath);

      if (newSize === previousSize && newSize !== 0) {
        // Não houve alterações no tamanho do arquivo, o download está completo
        downloadComplete = true;
      } else {
        // Houve alterações no tamanho do arquivo, aguardar mais 2 segundos
        previousSize = newSize;
      }
    }

    if (downloadComplete) {
      // Envia o caminho do arquivo para o cliente via socket.io
      send('newfile', filePath);

      // Realiza o download do arquivo
      await downloadFile(filePath);
    }
  }
});

function isFileNew(filePath) {
  // Verifica se o arquivo é mais recente do que o último arquivo processado
  return latestFile === null || latestFile < fs.statSync(filePath).mtime;
}

function isPartFile(filePath) {
  // Verifica se o arquivo é um arquivo .part
  return filePath.endsWith('.part');
}

// watcher.on('add', function (filePath) {
//   console.log('Novo arquivo:', filePath);
//   send('newfile', filePath); // Envia o caminho do arquivo para o cliente via socket.io
//   // Exibe um alerta na tela do cliente (requer suporte no lado do cliente)
//   // send('showalert', 'Novo arquivo detectado: ' + filePath);

//   // Realiza o download do arquivo
//   downloadFile(filePath);
// });

  // Incoming socket requests
  socket.on('open', checkAuth);
  socket.on('getfiles', getFiles);
  socket.on('downloadfile', downloadFile);
  socket.on('uploadfile', uploadFile);
  socket.on('deletefiles', deleteFiles);
  socket.on('createfolder', createFolder);
});

//// PCM Audio Wrapper ////
aio = socketIO(http, {path: SUBFOLDER + 'audio/socket.io'});
aio.on('connection', function (socket) {
  var record;
  let id = socket.id;

  function open() {
    if (audioEnabled) {
      if (record) record.end();
      record = pulse.createRecordStream({
                 channels: 2,
                 rate: 44100,
                 format: 'F32LE',
               });
      record.on('connection', function(){
        record.on('data', function(chunk) {
          // Only send real audio data
          if (chunk.length < 26456) {
            aio.sockets.to(id).emit('audio', chunk);
          }
        });
      });
    }
  }
  function close() {
    if (audioEnabled) {
      if (record) record.end();
    }
  }


  // Incoming socket requests
  socket.on('open', open);
  socket.on('close', close);
  socket.on('disconnect', close);
});

// Spin up application on 6900
app.use(SUBFOLDER, baseRouter);
http.listen(6900);

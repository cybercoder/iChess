var express = require('express')
  , path    = require('path')
  , crypto  = require('crypto')
  , http    = require('http')
  , winston = require('winston')
  , fs      = require('fs')
  , logger  = require('morgan')
  , cookieParser = require('cookie-parser')
  , bodyParser   = require('body-parser')
  , methodOverride = require('method-override')
  , session = require('express-session')
  ,sessionStore = require('express-mysql-session');

var Server = require("http").Server;

var options = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'usbw',
    database: 'ams'
}

var mysql      = require('mysql');
var dbconnection = mysql.createConnection(options);
 
 var sessionMiddleware = session({
    store: new sessionStore(options),
    key : 'connect.sid',
    secret: "45710b553b5b7293753d03bd3601f70a",
    resave: true,
    saveUninitialized: true
});

var app = express();
var server = Server(app);

app.set('port', process.env.OPENSHIFT_NODEJS_PORT || 3000);
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(methodOverride());
app.use(cookieParser('45710b553b5b7293753d03bd3601f70a'));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));


app.get('/', function(req, res) {
  res.render('index');
});

app.get('/about', function(req, res) {
  res.render('about');
});

app.get('/play/:token/:time/:increment', function(req, res) {
  res.render('play', {
    'token': req.params.token,
    'time': req.params.time,
    'increment': req.params.increment
  });
});

app.get('/logs', function(req, res) {
  fs.readFile(__dirname + '/logs/games.log', function (err, data) {
    if (err) {
      res.redirect('/');
    }
    res.set('Content-Type', 'text/plain');
    res.send(data);
  });
});

var games = {};
var timer;

/** 
 * Winston logger
 */
winston.add(winston.transports.File, {
  filename: __dirname + '/logs/games.log',
  handleExceptions: true,
  exitOnError: false,
  json: false
});
winston.remove(winston.transports.Console);
winston.handleExceptions(new winston.transports.Console());
winston.exitOnError = false;

/**
 * Sockets
 */
var io = require("socket.io")(server);

io.use(function(socket, next) {
    sessionMiddleware(socket.request, socket.request.res, next);
});

server.listen(3000);

io.sockets.on('connection', function (socket) {
  console.log(socket.request.sessionID) ;
  socket.on('start', function (data) {
    var token;
    var b = new Buffer(Math.random() + new Date().getTime() + socket.id);
    token = b.toString('base64').slice(12, 32);

    //token is valid for 5 minutes
    var timeout = setTimeout(function () {
      if (games[token].players.length === 0) {
        delete games[token];
        socket.emit('token-expired');
      }
    }, 5 * 60 * 1000);

    games[token] = {
      'creator': socket,
      'players': [],
      'interval': null,
      'timeout': timeout,
      'FEN' : '',
    };

    socket.emit('created', {
      'token': token
    });
  });

  socket.on('join', function (data) {
    var game, color, time = data.time;
    var reconnected_player =false ;

    if (!(data.token in games)) {
      socket.emit('token-invalid');
      return;
    }

    clearTimeout(games[data.token].timeout);
    game = games[data.token];
    
    if (game.players.length >= 2) {

      for (var i=0;i<game.players.length;i++) {
        console.log('++++++++++++++++'+game.players[i].session+'+++++++++++++++');
        if (socket.request.sessionID == game.players[i].session) {
          game.players[i].socket = socket ;
          reconnected_player=true ;
        }
      }
      if (!reconnected_player) {
        socket.emit('full');
        return;
      }
      else {
        socket.emit('player-reconnect',game) ;
      }
    } else if (game.players.length === 1) {
      if (game.players[0].color === 'black') {
        color = 'white';
      } else {
        color = 'black';
      }
      winston.log('info', 'Number of currently running games', { '#': Object.keys(games).length });
    } else {
      var colors = ['black', 'white'];

      color = colors[Math.floor(Math.random() * 2)];
    }

    //join room
    socket.join(data.token);
    if (!reconnected_player) {
      games[data.token].players.push({
        'id': socket.id,
        'session' : socket.request.sessionID,
        'socket': socket,
        'color': color,
        'time': data.time - data.increment + 1,
        'increment': data.increment
      });
    }

    if (!reconnected_player)
      game.creator.emit('ready', {});

    socket.emit('joined', {
      'color': color
    });
  });

  socket.on('timer-white', function (data) {
    runTimer('white', data.token, socket);
  });

  socket.on('timer-black', function (data) {
    runTimer('black', data.token, socket);
  });

  socket.on('timer-clear-interval', function (data) {
    if (data.token in games) {
      clearInterval(games[data.token].interval);
    }
  });

  socket.on('new-move', function (data) {
    var opponent;

    if (data.token in games) {
      opponent = getOpponent(data.token, socket);
      if (opponent) {
        opponent.socket.emit('move', {
          'move': data.move
        });
      }
    }
    games[data.token].FEN=data.fen ;
  });

  socket.on('resign', function (data) {
    if (data.token in games) {
      clearInterval(games[data.token].interval);
      io.sockets.in(data.token).emit('player-resigned', {
        'color': data.color
      });
    }
  });

  socket.on('rematch-offer', function (data) {
    var opponent;
    
    if (data.token in games) {
      opponent = getOpponent(data.token, socket);
      if (opponent) {
        opponent.socket.emit('rematch-offered');
      }
    }
  });

  socket.on('rematch-decline', function (data) {
    var opponent;

    if (data.token in games) {
      opponent = getOpponent(data.token, socket);
      if (opponent) {
        opponent.socket.emit('rematch-declined');
      }
    }
  });

  socket.on('rematch-confirm', function (data) {
    var opponent;

    if (data.token in games) {

      for(var j in games[data.token].players) {
        games[data.token].players[j].time = data.time - data.increment + 1;
        games[data.token].players[j].increment = data.increment;
        games[data.token].players[j].color = games[data.token].players[j].color === 'black' ? 'white' : 'black';
      }

      opponent = getOpponent(data.token, socket);
      if (opponent) {
        io.sockets.in(data.token).emit('rematch-confirmed');
      }
    }
  })

  socket.on('disconnect', function (data) {
    var player, opponent, game;
    for (var token in games) {
    game = games[token];

      for (var j in game.players) {
        player = game.players[j];

        if (player.socket === socket) {
          opponent = game.players[Math.abs(j - 1)];
          if (opponent) {
            setInterval(function(){opponent.socket.emit('opponent-disconnected')},40*1000);
            clearInterval(games[token].interval);
            //delete games[token];
          }         
        }
      }
    }
  });

  socket.on('reconnect',function(){
    console.log('reconnected') ;
  });

  socket.on('send-message', function (data) {
    if (data.token in games) {
      var opponent = getOpponent(data.token, socket);
      if (opponent) {
        opponent.socket.emit('receive-message', data);
      }
    }
  });
});

function runTimer(color, token, socket) {
  var player, time_left, game = games[token];

  if (!game) return;

  for (var i in game.players) {
    player = game.players[i];

    if (player.socket === socket && player.color === color) {

      clearInterval(games[token].interval);
      games[token].players[i].time += games[token].players[i].increment;

      return games[token].interval = setInterval(function() {
        games[token].players[i].time -= 1;
        time_left = games[token].players[i].time;

        if (time_left >= 0) {
          io.sockets.in(token).emit('countdown', {
            'time': time_left,
            'color': color
          });
        } else {
          io.sockets.in(token).emit('countdown-gameover', {
            'color': color
          });
          clearInterval(games[token].interval);
        }
      }, 1000);
    }
  }
}

function getOpponent(token, socket) {
  var player, game = games[token];

  for (var j in game.players) {
    player = game.players[j];

    if (player.socket === socket) {
      var opponent = game.players[Math.abs(j - 1)];

      return opponent;
    }
  }
}

function isInArray(value, array) {
  return array.indexOf(value) > -1;
}
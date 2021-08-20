let http = require("http");
let WebSocketServer = require("websocket").server;
let webServer = http.createServer({}, handleWebRequest);

function handleWebRequest(req, res) {
  console.log("Received request for " + req.url);
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.write("Hello there");
  res.end();
}

webServer.listen(process.env.PORT || 3000, function () {
  console.log("webserver started");
});

let wsServer = new WebSocketServer({
  httpServer: webServer,
  autoAcceptConnections: false,
});

wsServer.on("request", function (request) {
  console.log("Request: ")//, request);
  let connection = request.accept(null, request.origin);
  connection.on("message", function (message) {
    console.log("Message: ", message);
  });
  connection.on("close", function (reason, description) {
    console.log("Close: ", reason, description);
  });
});

"use strict";

var myHostname = window.location.hostname;
if (!myHostname) {
  myHostname = "localhost";
}
log("Hostname: " + myHostname);

var connection = null;
var clientID = 0;
var mediaConstraints = {
  audio: true,
  video: {
    aspectRatio: {
      ideal: 1.333333,
    },
  },
};
var myUsername = null;
var targetUsername = null;
var myPeerConnection = null;
var transceiver = null;
var webcamStream = null;

function log(text) {
  var time = new Date();
  console.log("[" + time.toLocaleTimeString() + "] " + text);
}

function log_error(text) {
  var time = new Date();
  console.trace("[" + time.toLocaleTimeString() + "] " + text);
}

function sendToServer(msg) {
  var msgJSON = JSON.stringify(msg);
  log("Sending '" + msg.type + "' message: " + msgJSON);
  connection.send(msgJSON);
}

function setUsername() {
  myUsername = "Caller-" + Date.now();
  sendToServer({
    name: myUsername,
    date: Date.now(),
    id: clientID,
    type: "username",
  });
}

function connect() {
  var serverUrl;
  var scheme = "ws";

  if (document.location.protocol === "https:") {
    scheme += "s";
  }
  serverUrl = scheme + "://" + myHostname; // + ":3000";

  log(`Connecting to server: ${serverUrl}`);
  connection = new WebSocket(serverUrl, "json");

  connection.onopen = function (evt) {
    // anything you want to do on connect.
  };

  connection.onerror = function (evt) {
    console.dir(evt);
  };

  connection.onmessage = function (evt) {
    var msg = JSON.parse(evt.data);
    log("Message received: ");
    // console.dir(msg);
    var time = new Date(msg.date);
    var timeStr = time.toLocaleTimeString();

    switch (msg.type) {
      case "id":
        clientID = msg.id;
        setUsername();
        break;

      case "username":
        text =
          "<b>User <em>" +
          msg.name +
          "</em> signed in at " +
          timeStr +
          "</b><br>";
        break;

      case "message":
        console.log(msg, myUsername);
        if (msg.name !== myUsername) {
          document.querySelector("#received-subtitles").innerText = msg.text;
        }
        break;

      case "rejectusername":
        myUsername = msg.name;
        text =
          "<b>Your username has been set to <em>" +
          myUsername +
          "</em> because the name you chose is in use.</b><br>";
        break;

      case "userlist": // Received an updated user list
        handleUserlistMsg(msg);
        break;

      // Signaling messages: these messages are used to trade WebRTC
      // signaling information during negotiations leading up to a video
      // call.

      case "video-offer": // Invitation and offer to chat
        handleVideoOfferMsg(msg);
        break;

      case "video-answer": // Callee has answered our offer
        handleVideoAnswerMsg(msg);
        break;

      case "new-ice-candidate": // A new ICE candidate has been received
        handleNewICECandidateMsg(msg);
        break;

      case "hang-up": // The other peer has hung up the call
        handleHangUpMsg(msg);
        break;

      default:
        log_error("Unknown message received:");
        log_error(msg);
    }

    // If there's text to insert into the chat buffer, do so now, then
    // scroll the chat panel so that the new text is visible.

    // if (text.length) {
    //   chatBox.innerHTML += text;
    //   chatBox.scrollTop = chatBox.scrollHeight - chatBox.clientHeight;
    // }
  };
}

function sendText(text) {
  var msg = {
    text: text,
    type: "message",
    id: clientID,
    date: Date.now(),
  };
  sendToServer(msg);
}

// Create the RTCPeerConnection which knows how to talk to our
// selected STUN/TURN server and then uses getUserMedia() to find
// our camera and microphone and add that stream to the connection for
// use in our video call. Then we configure event handlers to get
// needed notifications on the call.

async function createPeerConnection() {
  log("Setting up a connection...");

  // Create an RTCPeerConnection which knows to use our chosen
  // STUN server.

  myPeerConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: stunServers.map((server) => `stun:${server}?transport=udp`),
      },
    ],
  });

  // Set up event handlers for the ICE negotiation process.
  myPeerConnection.onicecandidate = handleICECandidateEvent;
  myPeerConnection.oniceconnectionstatechange =
    handleICEConnectionStateChangeEvent;
  myPeerConnection.onicegatheringstatechange =
    handleICEGatheringStateChangeEvent;
  myPeerConnection.onsignalingstatechange = handleSignalingStateChangeEvent;
  myPeerConnection.onnegotiationneeded = handleNegotiationNeededEvent;
  myPeerConnection.ontrack = handleTrackEvent;
}

// Called by the WebRTC layer to let us know when it's time to
// begin, resume, or restart ICE negotiation.

async function handleNegotiationNeededEvent() {
  log("*** Negotiation needed");

  try {
    log("---> Creating offer");
    const offer = await myPeerConnection.createOffer();

    // If the connection hasn't yet achieved the "stable" state,
    // return to the caller. Another negotiationneeded event
    // will be fired when the state stabilizes.

    if (myPeerConnection.signalingState != "stable") {
      log("     -- The connection isn't stable yet; postponing...");
      return;
    }

    // Establish the offer as the local peer's current
    // description.

    log("---> Setting local description to the offer");
    await myPeerConnection.setLocalDescription(offer);

    // Send the offer to the remote peer.

    log("---> Sending the offer to the remote peer");
    sendToServer({
      name: myUsername,
      target: targetUsername,
      type: "video-offer",
      sdp: myPeerConnection.localDescription,
    });
  } catch (err) {
    log(
      "*** The following error occurred while handling the negotiationneeded event:"
    );
    reportError(err);
  }
}

// Called by the WebRTC layer when events occur on the media tracks
// on our WebRTC call. This includes when streams are added to and
// removed from the call.
//
// track events include the following fields:
//
// RTCRtpReceiver       receiver
// MediaStreamTrack     track
// MediaStream[]        streams
// RTCRtpTransceiver    transceiver
//
// In our case, we're just taking the first stream found and attaching
// it to the <video> element for incoming media.

function handleTrackEvent(event) {
  log("*** Track event");
  document.getElementById("received-video").srcObject = event.streams[0];
  document.getElementById("action-button").disabled = false;
}

// Handles |icecandidate| events by forwarding the specified
// ICE candidate (created by our local ICE agent) to the other
// peer through the signaling server.

function handleICECandidateEvent(event) {
  if (event.candidate) {
    log("*** Outgoing ICE candidate: " + event.candidate.candidate);

    sendToServer({
      type: "new-ice-candidate",
      target: targetUsername,
      candidate: event.candidate,
    });
  }
}

// Handle |iceconnectionstatechange| events. This will detect
// when the ICE connection is closed, failed, or disconnected.
//
// This is called when the state of the ICE agent changes.

function handleICEConnectionStateChangeEvent(event) {
  log(
    "*** ICE connection state changed to " + myPeerConnection.iceConnectionState
  );

  switch (myPeerConnection.iceConnectionState) {
    case "closed":
    case "failed":
    case "disconnected":
      closeVideoCall();
      break;
  }
}

// Set up a |signalingstatechange| event handler. This will detect when
// the signaling connection is closed.
//
// NOTE: This will actually move to the new RTCPeerConnectionState enum
// returned in the property RTCPeerConnection.connectionState when
// browsers catch up with the latest version of the specification!

function handleSignalingStateChangeEvent(event) {
  log(
    "*** WebRTC signaling state changed to: " + myPeerConnection.signalingState
  );
  switch (myPeerConnection.signalingState) {
    case "closed":
      closeVideoCall();
      break;
  }
}

// Handle the |icegatheringstatechange| event. This lets us know what the
// ICE engine is currently working on: "new" means no networking has happened
// yet, "gathering" means the ICE engine is currently gathering candidates,
// and "complete" means gathering is complete. Note that the engine can
// alternate between "gathering" and "complete" repeatedly as needs and
// circumstances change.
//
// We don't need to do anything when this happens, but we log it to the
// console so you can see what's going on when playing with the sample.

function handleICEGatheringStateChangeEvent(event) {
  log(
    "*** ICE gathering state changed to: " + myPeerConnection.iceGatheringState
  );
}

// Given a message containing a list of usernames, this function
// populates the user list box with those names, making each item
// clickable to allow starting a video call.

function handleUserlistMsg(msg) {
  msg.users.forEach(function (username) {
    if (username === myUsername) {
      return;
    }
    var actionButton = document.querySelector("#action-button");
    actionButton.classList.add("ready");
    actionButton.innerText = "接听";
    actionButton.setAttribute("callerId", username);
    actionButton.onclick = invite;
  });
}

// Close the RTCPeerConnection and reset variables so that the user can
// make or receive another call if they wish. This is called both
// when the user hangs up, the other user hangs up, or if a connection
// failure is detected.

function closeVideoCall() {
  var localVideo = document.getElementById("local-video");

  log("Closing the call");

  // Close the RTCPeerConnection

  if (myPeerConnection) {
    log("--> Closing the peer connection");

    // Disconnect all our event listeners; we don't want stray events
    // to interfere with the hangup while it's ongoing.

    myPeerConnection.ontrack = null;
    myPeerConnection.onnicecandidate = null;
    myPeerConnection.oniceconnectionstatechange = null;
    myPeerConnection.onsignalingstatechange = null;
    myPeerConnection.onicegatheringstatechange = null;
    myPeerConnection.onnotificationneeded = null;

    // Stop all transceivers on the connection

    myPeerConnection.getTransceivers().forEach((transceiver) => {
      transceiver.stop();
    });

    // Stop the webcam preview as well by pausing the <video>
    // element, then stopping each of the getUserMedia() tracks
    // on it.

    if (localVideo.srcObject) {
      localVideo.pause();
      localVideo.srcObject.getTracks().forEach((track) => {
        track.stop();
      });
    }

    // Close the peer connection

    myPeerConnection.close();
    myPeerConnection = null;
    webcamStream = null;
  }

  // Disable the hangup button

  document.getElementById("action-button").disabled = true;
  targetUsername = null;
}

// Handle the "hang-up" message, which is sent if the other peer
// has hung up the call or otherwise disconnected.

function handleHangUpMsg(msg) {
  log("*** Received hang up notification from other peer");
  closeVideoCall();
}

// Hang up the call by closing our end of the connection, then
// sending a "hang-up" message to the other peer (keep in mind that
// the signaling is done on a different connection). This notifies
// the other peer that the connection should be terminated and the UI
// returned to the "no call in progress" state.

function hangUpCall() {
  closeVideoCall();
  sendToServer({
    name: myUsername,
    target: targetUsername,
    type: "hang-up",
  });
}

// Handle a click on an item in the user list by inviting the clicked
// user to video chat. Note that we don't actually send a message to
// the callee here -- calling RTCPeerConnection.addTrack() issues
// a |notificationneeded| event, so we'll let our handler for that
// make the offer.

async function invite(evt) {
  log("Starting to prepare an invitation");
  if (myPeerConnection) {
    alert("You can't start a call because you already have one open!");
  } else {
    var clickedUsername = evt.target.getAttribute("callerId");
    var actionButton = document.querySelector("#action-button");
    actionButton.classList.remove("ready");

    // Don't allow users to call themselves, because weird.

    if (clickedUsername === myUsername) {
      alert(
        "I'm afraid I can't let you talk to yourself. That would be weird."
      );
      return;
    }

    // Record the username being called for future reference

    targetUsername = clickedUsername;
    log("Inviting user " + targetUsername);

    // Call createPeerConnection() to create the RTCPeerConnection.
    // When this returns, myPeerConnection is our RTCPeerConnection
    // and webcamStream is a stream coming from the camera. They are
    // not linked together in any way yet.

    log("Setting up connection to invite user: " + targetUsername);
    createPeerConnection();

    // Get access to the webcam stream and attach it to the
    // "preview" box (id "local_video").

    try {
      webcamStream = await navigator.mediaDevices.getUserMedia(
        mediaConstraints
      );
      document.getElementById("local-video").srcObject = webcamStream;
    } catch (err) {
      handleGetUserMediaError(err);
      return;
    }

    // Add the tracks from the stream to the RTCPeerConnection

    try {
      webcamStream
        .getTracks()
        .forEach(
          (transceiver = (track) =>
            myPeerConnection.addTransceiver(track, { streams: [webcamStream] }))
        );
    } catch (err) {
      handleGetUserMediaError(err);
    }
  }
}

// Accept an offer to video chat. We configure our local settings,
// create our RTCPeerConnection, get and attach our local camera
// stream, then create and send an answer to the caller.

async function handleVideoOfferMsg(msg) {
  targetUsername = msg.name;

  var actionButton = document.querySelector("#action-button");
  actionButton.classList.remove("ready");
  actionButton.classList.add("hangup");
  actionButton.innerText = "挂断";
  actionButton.onclick = hangUpCall;
  console.log("handleVideoOfferMsg");
  startContinuousRecognition();

  // If we're not already connected, create an RTCPeerConnection
  // to be linked to the caller.

  log("Received video chat offer from " + targetUsername);
  if (!myPeerConnection) {
    createPeerConnection();
  }

  // We need to set the remote description to the received SDP offer
  // so that our local WebRTC layer knows how to talk to the caller.

  var desc = new RTCSessionDescription(msg.sdp);

  // If the connection isn't stable yet, wait for it...

  if (myPeerConnection.signalingState != "stable") {
    log("  - But the signaling state isn't stable, so triggering rollback");

    // Set the local and remove descriptions for rollback; don't proceed
    // until both return.
    await Promise.all([
      myPeerConnection.setLocalDescription({ type: "rollback" }),
      myPeerConnection.setRemoteDescription(desc),
    ]);
    return;
  } else {
    log("  - Setting remote description");
    await myPeerConnection.setRemoteDescription(desc);
  }

  // Get the webcam stream if we don't already have it

  if (!webcamStream) {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia(
        mediaConstraints
      );
    } catch (err) {
      handleGetUserMediaError(err);
      return;
    }

    document.getElementById("local-video").srcObject = webcamStream;

    // Add the camera stream to the RTCPeerConnection

    try {
      webcamStream
        .getTracks()
        .forEach(
          (transceiver = (track) =>
            myPeerConnection.addTransceiver(track, { streams: [webcamStream] }))
        );
    } catch (err) {
      handleGetUserMediaError(err);
    }
  }

  log("---> Creating and sending answer to caller");

  await myPeerConnection.setLocalDescription(
    await myPeerConnection.createAnswer()
  );

  sendToServer({
    name: myUsername,
    target: targetUsername,
    type: "video-answer",
    sdp: myPeerConnection.localDescription,
  });
}

// Responds to the "video-answer" message sent to the caller
// once the callee has decided to accept our request to talk.

async function handleVideoAnswerMsg(msg) {
  log("*** Call recipient has accepted our call");

  // Configure the remote description, which is the SDP payload
  // in our "video-answer" message.

  var desc = new RTCSessionDescription(msg.sdp);
  await myPeerConnection.setRemoteDescription(desc).catch(reportError);
}

// A new ICE candidate has been received from the other peer. Call
// RTCPeerConnection.addIceCandidate() to send it along to the
// local ICE framework.

async function handleNewICECandidateMsg(msg) {
  var candidate = new RTCIceCandidate(msg.candidate);

  log("*** Adding received ICE candidate: " + JSON.stringify(candidate));
  try {
    await myPeerConnection.addIceCandidate(candidate);
  } catch (err) {
    reportError(err);
  }
}

// Handle errors which occur when trying to access the local media
// hardware; that is, exceptions thrown by getUserMedia(). The two most
// likely scenarios are that the user has no camera and/or microphone
// or that they declined to share their equipment when prompted. If
// they simply opted not to share their media, that's not really an
// error, so we won't present a message in that situation.

function handleGetUserMediaError(e) {
  log_error(e);
  switch (e.name) {
    case "NotFoundError":
      alert(
        "Unable to open your call because no camera and/or microphone" +
          "were found."
      );
      break;
    case "SecurityError":
    case "PermissionDeniedError":
      // Do nothing; this is the same as the user canceling the call.
      break;
    default:
      alert("Error opening your camera and/or microphone: " + e.message);
      break;
  }

  // Make sure we shut down our end of the RTCPeerConnection so we're
  // ready to try again.

  closeVideoCall();
}

// Handles reporting errors. Currently, we just dump stuff to console but
// in a real-world application, an appropriate (and user-friendly)
// error message should be displayed.

function reportError(errMessage) {
  log_error(`Error ${errMessage.name}: ${errMessage.message}`);
}

window.onload = function () {
  dragElement(document.querySelector("#local-video"));
  connect();
};

// ======
// Make draggable
// ======
function dragElement(elmnt) {
  var pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;
  elmnt.onmousedown = drag;
  elmnt.ontouchstart = drag;

  function drag(e) {
    e = e || window.event;
    // e.preventDefault();
    // get the mouse cursor position at startup:
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.ontouchend = closeDragElement;
    // call a function whenever the cursor moves:
    document.onmousemove = elementDrag;
    document.ontouchmove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    // e.preventDefault();
    var clientX = e.clientX || e.touches[0].clientX;
    var clientY = e.clientY || e.touches[0].clientY;
    // calculate the new cursor position:
    pos1 = pos3 - clientX;
    pos2 = pos4 - clientY;
    pos3 = clientX;
    pos4 = clientY;
    // set the element's new position:
    elmnt.style.top = elmnt.offsetTop - pos2 + "px";
    elmnt.style.left = elmnt.offsetLeft - pos1 + "px";
  }

  function closeDragElement() {
    // stop moving when mouse button is released:
    document.onmouseup = null;
    document.onmousemove = null;
    document.ontouchend = null;
    document.ontouchmove = null;
  }
}

// ======
// Translation stuff
// ======
var languageSourceSelector;
var recognizer;
let apiKey;
let sourceLanguage;
var SpeechSDK;

apiKey = localStorage.getItem("key1");
if (!apiKey) {
  apiKey = prompt("向 Nathan 索取代码");
  localStorage.setItem("key1", apiKey);
}
let translateFromEnglish = document.getElementById("translate-from-english");
let translateFromChinese = document.getElementById("translate-from-chinese");
let stopTranslate = document.getElementById("stop-translate");

translateFromEnglish.onclick = () => {
  sourceLanguage = "en-AU";
  startContinuousRecognition();
  stopTranslate.disabled = false;
  translateFromEnglish.disabled = true;
  translateFromChinese.disabled = true;
};

translateFromChinese.onclick = () => {
  sourceLanguage = "zh-CN";
  startContinuousRecognition();
  stopTranslate.disabled = false;
  translateFromEnglish.disabled = true;
  translateFromChinese.disabled = true;
};

stopTranslate.onclick = stopContinuousRecognition;

function startContinuousRecognition() {
  console.log("startContinuousRecognition");

  var speechConfig = SpeechSDK.SpeechTranslationConfig.fromSubscription(
    apiKey,
    "australiaeast"
  );
  speechConfig.speechRecognitionLanguage = sourceLanguage;
  speechConfig.addTargetLanguage(
    sourceLanguage === "en-AU" ? "zh-CN" : "en-AU"
  );
  var audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  recognizer = new SpeechSDK.TranslationRecognizer(speechConfig, audioConfig);

  recognizer.startContinuousRecognitionAsync(
    () => console.log("startContinuousRecognitionAsync"),
    (err) => console.log(err)
  );

  recognizer.recognizing = translateAndSend;
  recognizer.recognized = translateAndSend;
  function translateAndSend(s, e) {
    console.log("recognized text", e.result.text);
    document.querySelector("#local-subtitles").innerText = e.result.text;
    let translation = e.result.translations.get(
      sourceLanguage === "en-AU" ? "zh-Hans" : "en"
    );
    sendText(translation);
  }
}

function stopContinuousRecognition() {
  recognizer.stopContinuousRecognitionAsync(
    () => {
      console.log("stopContinuousRecognitionAsync");
      document.querySelector("#local-subtitles").innerText = "";
      // sendText("");
      stopTranslate.disabled = true;
      translateFromEnglish.disabled = false;
      translateFromChinese.disabled = false;   
      recognizer = null; 
    },
    (err) => console.log(err)
  );
}

var stunServers = [
  // "iphone-stun.strato-iphone.de:3478",
  // "numb.viagenie.ca:3478",
  // "stun.12connect.com:3478",
  // "stun.12voip.com:3478",
  // "stun.1und1.de:3478",
  // "stun.3cx.com:3478",
  // "stun.acrobits.cz:3478",
  // "stun.actionvoip.com:3478",
  // "stun.advfn.com:3478",
  // "stun.altar.com.pl:3478",
  // "stun.antisip.com:3478",
  // "stun.avigora.fr:3478",
  // "stun.bluesip.net:3478",
  // "stun.cablenet-as.net:3478",
  // "stun.callromania.ro:3478",
  // "stun.callwithus.com:3478",
  // "stun.cheapvoip.com:3478",
  // "stun.cloopen.com:3478",
  // "stun.commpeak.com:3478",
  // "stun.cope.es:3478",
  // "stun.counterpath.com:3478",
  // "stun.counterpath.net:3478",
  // "stun.dcalling.de:3478",
  // "stun.demos.ru:3478",
  // "stun.dus.net:3478",
  // "stun.easycall.pl:3478",
  // "stun.easyvoip.com:3478",
  // "stun.ekiga.net:3478",
  // "stun.epygi.com:3478",
  // "stun.etoilediese.fr:3478",
  // "stun.faktortel.com.au:3478",
  // "stun.freecall.com:3478",
  // "stun.freeswitch.org:3478",
  // "stun.freevoipdeal.com:3478",
  // "stun.gmx.de:3478",
  // "stun.gmx.net:3478",
  // "stun.halonet.pl:3478",
  // "stun.hoiio.com:3478",
  // "stun.hosteurope.de:3478",
  // "stun.infra.net:3478",
  // "stun.internetcalls.com:3478",
  // "stun.intervoip.com:3478",
  // "stun.ipfire.org:3478",
  // "stun.ippi.fr:3478",
  // "stun.ipshka.com:3478",
  // "stun.it1.hr:3478",
  // "stun.ivao.aero:3478",
  // "stun.jumblo.com:3478",
  // "stun.justvoip.com:3478",
  // "stun.l.google.com:19302",
  // "stun.linphone.org:3478",
  // "stun.liveo.fr:3478",
  // "stun.lowratevoip.com:3478",
  // "stun.lundimatin.fr:3478",
  // "stun.mit.de:3478",
  // "stun.miwifi.com:3478",
  // "stun.modulus.gr:3478",
  // "stun.myvoiptraffic.com:3478",
  // "stun.netappel.com:3478",
  // "stun.netgsm.com.tr:3478",
  // "stun.nfon.net:3478",
  // "stun.nonoh.net:3478",
  // "stun.nottingham.ac.uk:3478",
  // "stun.ooma.com:3478",
  // "stun.ozekiphone.com:3478",
  // "stun.pjsip.org:3478",
  // "stun.poivy.com:3478",
  // "stun.powervoip.com:3478",
  // "stun.ppdi.com:3478",
  // "stun.qq.com:3478",
  // "stun.rackco.com:3478",
  // "stun.rockenstein.de:3478",
  // "stun.rolmail.net:3478",
  // "stun.rynga.com:3478",
  // "stun.schlund.de:3478",
  // "stun.sigmavoip.com:3478",
  // "stun.sip.us:3478",
  // "stun.sipdiscount.com:3478",
  // "stun.sipgate.net:10000",
  // "stun.sipgate.net:3478",
  // "stun.siplogin.de:3478",
  // "stun.sipnet.net:3478",
  // "stun.sipnet.ru:3478",
  // "stun.sippeer.dk:3478",
  // "stun.siptraffic.com:3478",
  // "stun.sma.de:3478",
  // "stun.smartvoip.com:3478",
  // "stun.smsdiscount.com:3478",
  // "stun.solcon.nl:3478",
  // "stun.solnet.ch:3478",
  // "stun.sonetel.com:3478",
  // "stun.sonetel.net:3478",
  // "stun.sovtest.ru:3478",
  // "stun.srce.hr:3478",
  // "stun.stunprotocol.org:3478",
  // "stun.t-online.de:3478",
  // "stun.tel.lu:3478",
  // "stun.telbo.com:3478",
  // "stun.tng.de:3478",
  // "stun.twt.it:3478",
  // "stun.uls.co.za:3478",
  // "stun.unseen.is:3478",
  // "stun.usfamily.net:3478",
  // "stun.viva.gr:3478",
  // "stun.vivox.com:3478",
  // "stun.vo.lu:3478",
  // "stun.voicetrading.com:3478",
  // "stun.voip.aebc.com:3478",
  // "stun.voip.blackberry.com:3478",
  // "stun.voip.eutelia.it:3478",
  // "stun.voipblast.com:3478",
  // "stun.voipbuster.com:3478",
  // "stun.voipbusterpro.com:3478",
  // "stun.voipcheap.co.uk:3478",
  // "stun.voipcheap.com:3478",
  // "stun.voipgain.com:3478",
  // "stun.voipgate.com:3478",
  // "stun.voipinfocenter.com:3478",
  // "stun.voipplanet.nl:3478",
  "stun.voippro.com:3478",
  // "stun.voipraider.com:3478",
  "stun.voipstunt.com:3478",
  "stun.voipwise.com:3478",
  "stun.voipzoom.com:3478",
  // "stun.voys.nl:3478",
  // "stun.voztele.com:3478",
  // "stun.webcalldirect.com:3478",
  // "stun.wifirst.net:3478",
  // "stun.xtratelecom.es:3478",
  // "stun.zadarma.com:3478",
  // "stun1.faktortel.com.au:3478",
  // "stun1.l.google.com:19302",
  // "stun2.l.google.com:19302",
  // "stun3.l.google.com:19302",
  // "stun4.l.google.com:19302",
  // "stun.nextcloud.com:443",
  // "relay.webwormhole.io:3478",
];

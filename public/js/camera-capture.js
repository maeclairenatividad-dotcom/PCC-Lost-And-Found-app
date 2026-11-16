/* Legacy-free selfie capture for the Lost & Found app.
   Turns the "Take a selfie" triggers into a live camera overlay.
   Falls back to the file input when no camera / no permission / http on LAN. */
function cameraCaptureInit(inputId) {
  var modal = document.getElementById('camModal');
  var video = document.getElementById('camVideo');
  var canvas = document.getElementById('camCanvas');
  var shot = document.getElementById('camShot');
  var cancel = document.getElementById('camCancel');
  var retake = document.getElementById('camRetake');
  var confirmBtn = document.getElementById('camConfirm');
  var note = document.getElementById('camNote');
  var input = document.getElementById(inputId);

  if (!modal || !video || !input) return;

  var stream = null;
  var captured = false;

  function setRecording() {
    video.hidden = false;
    canvas.hidden = true;
    video.controls = false;
    shot.hidden = false;
    confirmBtn.hidden = true;
    retake.hidden = true;
    note.textContent = 'Allow camera access and frame yourself in the box.';
    captured = false;
  }

  function close() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    video.srcObject = null;
    modal.hidden = true;
    setRecording();
  }

  function fallback() {
    if (input) input.click();
  }

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallback();
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      modal.hidden = false;
      setRecording();
    }).catch(function () {
      fallback();
    });
  }

  function capture() {
    if (!stream) return;
    var w = video.videoWidth || 640;
    var h = video.videoHeight || 480;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    video.hidden = true;
    canvas.hidden = false;
    captured = true;
    shot.hidden = true;
    confirmBtn.hidden = false;
    retake.hidden = false;
    note.textContent = 'Looks good? Use it, or retake.';
  }

  function usePhoto() {
    if (!captured) return;
    canvas.toBlob(function (blob) {
      if (!blob) {
        note.textContent = 'Could not save the capture. Try the photo picker instead.';
        return;
      }
      try {
        var dt = new DataTransfer();
        dt.items.add(new File([blob], 'selfie.jpg', { type: 'image/jpeg' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      } catch (e) {
        note.textContent = 'Capturing is not supported in this browser. Use the photo picker instead.';
      }
    }, 'image/jpeg', 0.92);
  }

  cancel.addEventListener('click', close);
  retake.addEventListener('click', setRecording);
  confirmBtn.addEventListener('click', usePhoto);
  shot.addEventListener('click', capture);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  var triggers = document.querySelectorAll('[data-selfie]');
  for (var i = 0; i < triggers.length; i++) {
    triggers[i].addEventListener('click', function (e) {
      e.preventDefault();
      openCamera();
    });
  }
}

window.cameraCaptureInit = cameraCaptureInit;
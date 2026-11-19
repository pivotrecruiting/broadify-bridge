#!/usr/bin/env python3
"""Manual spike driver for the meeting helper screen-share backends.

Starts a helper binary, drives it over its control channel (Unix socket on
macOS/Linux, named pipe on Windows) and measures the screen-share path.

Modes:
  --list-only         screen.list + state.get, then shutdown (no UI, no capture).
  --probe             macOS: screen.pick, wait for a selection, stop.
                      Windows: screen.start with --source, stop.
  --full              like --probe, then enable the media layer
                      (source=screen, fullscreen), measure for --measure
                      seconds, save preview frames, switch to PiP, stop.

Examples:
  macOS:   python3 spike-screen-share.py --full --motion --helper "<.app>/Contents/MacOS/BroadifyMeetingHelper" --out ./full1
  Windows: python spike-screen-share.py --list-only --helper .\\meeting-helper.exe --out .\\list1
           python spike-screen-share.py --full --motion --source monitor:0x10001 --helper .\\meeting-helper.exe --out .\\full1

The MJPEG preview port is used as the pipeline's output consumer; frames are
saved as share-fullscreen.jpg / share-pip.jpg in --out.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time

IS_WINDOWS = os.name == "nt"

ap = argparse.ArgumentParser()
ap.add_argument("--helper", required=True, help="helper executable")
ap.add_argument("--out", required=True, help="output directory for logs/frames")
ap.add_argument("--list-only", action="store_true")
ap.add_argument("--probe", action="store_true")
ap.add_argument("--full", action="store_true")
ap.add_argument("--source", default="", help="Windows: source_id from screen.list (monitor:0x.. / window:0x..)")
ap.add_argument("--motion", action="store_true", help="generate on-screen motion during the measurement")
ap.add_argument("--wait", type=int, default=120, help="seconds to wait for the picker selection (macOS)")
ap.add_argument("--measure", type=int, default=60)
ap.add_argument("--width", type=int, default=1920)
ap.add_argument("--height", type=int, default=1080)
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--preview-port", type=int, default=9231)
ap.add_argument("--raw-port", type=int, default=18831)
args = ap.parse_args()
if not (args.list_only or args.probe or args.full):
    args.probe = True

os.makedirs(args.out, exist_ok=True)
if IS_WINDOWS:
    control_path = rf"\\.\pipe\broadify-meeting-spike-{os.getpid()}"
else:
    control_path = f"/tmp/bfy-spike-{os.getpid()}.sock"
log_path = os.path.join(args.out, "helper.log")
log = open(log_path, "wb")
proc = subprocess.Popen(
    [args.helper, "--run", "--control-socket", control_path, "--parent-pid", str(os.getpid()),
     "--width", str(args.width), "--height", str(args.height), "--fps", str(args.fps),
     "--preview-port", str(args.preview_port), "--vcam-frame-port", str(args.raw_port)],
    stdout=log, stderr=subprocess.STDOUT)
print(f"[spike] helper pid={proc.pid} log={log_path} control={control_path}")


def rpc(obj, timeout=5):
    """One newline-delimited JSON request per connection (helper control protocol)."""
    line = (json.dumps(obj) + "\n").encode()
    if IS_WINDOWS:
        # CreateFile on the pipe; the helper answers one request per connection.
        with open(control_path, "r+b", buffering=0) as pipe:
            pipe.write(line)
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = pipe.read(65536)
                if not chunk:
                    break
                buf += chunk
        return buf.decode(errors="replace").strip()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(control_path)
    s.sendall(line)
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return buf.decode(errors="replace").strip()


def control_ready():
    if IS_WINDOWS:
        try:
            rpc({"id": "0", "method": "control.ping"})
            return True
        except OSError:
            return False
    return os.path.exists(control_path)


def events(type_filter=None):
    out = []
    try:
        content = open(log_path, "rb").read().decode(errors="replace")
    except OSError:
        return out
    for raw in content.splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if type_filter is None or obj.get("type") in type_filter:
            out.append(obj)
    return out


def cpu_percent(pid):
    """Helper CPU in percent of one core (ps on POSIX, a two-sample WMI query on Windows)."""
    try:
        if IS_WINDOWS:
            script = (
                "$p=Get-Process -Id %d; $t1=$p.TotalProcessorTime; Start-Sleep -Milliseconds 500; "
                "$p=Get-Process -Id %d; $t2=$p.TotalProcessorTime; "
                "[math]::Round((($t2-$t1).TotalMilliseconds/500.0)*100,1)" % (pid, pid)
            )
            out = subprocess.check_output(["powershell", "-NoProfile", "-Command", script], text=True)
        else:
            out = subprocess.check_output(["ps", "-o", "%cpu=", "-p", str(pid)], text=True)
        return float(out.strip() or "0")
    except Exception:
        return -1.0


motion_proc = None


def start_motion(seconds):
    """Opens a moving window so a shared display keeps changing (tkinter; Finder fallback on macOS)."""
    global motion_proc
    tk_script = (
        "import tkinter, time, sys\n"
        "root=tkinter.Tk(); root.title('Broadify spike motion'); root.geometry('640x400+120+120')\n"
        "c=tkinter.Canvas(root,width=640,height=400,bg='white'); c.pack()\n"
        "r=c.create_rectangle(0,0,120,120,fill='red'); t=c.create_text(320,380,text='',font=('Helvetica',20))\n"
        "x=y=0; dx=dy=9; end=time.time()+%d\n"
        "def step():\n"
        "    global x,y,dx,dy\n"
        "    x+=dx; y+=dy\n"
        "    if x<0 or x>520: dx=-dx\n"
        "    if y<0 or y>280: dy=-dy\n"
        "    c.coords(r,x,y,x+120,y+120); c.itemconfig(t,text='%%.1f' %% time.time())\n"
        "    if time.time()>end: root.destroy(); return\n"
        "    root.after(16, step)\n"
        "root.after(16, step); root.mainloop()\n" % seconds
    )
    try:
        subprocess.check_call([sys.executable, "-c", "import tkinter"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        motion_proc = subprocess.Popen([sys.executable, "-c", tk_script])
        print("[spike] motion: tkinter window")
        return
    except Exception:
        pass
    if sys.platform == "darwin":
        osa = (
            "open -a Finder \"$HOME\" >/dev/null 2>&1; sleep 1; end=$((SECONDS+%d)); i=0; "
            "while [ $SECONDS -lt $end ]; do x=$((100+(i*37)%%900)); y=$((100+(i*23)%%500)); "
            "osascript -e \"tell application \\\"Finder\\\" to set bounds of front window to {$x,$y,$((x+700)),$((y+450))}\" >/dev/null 2>&1; "
            "i=$((i+1)); sleep 0.05; done; osascript -e 'tell application \"Finder\" to close front window' >/dev/null 2>&1" % seconds
        )
        motion_proc = subprocess.Popen(["bash", "-c", osa])
        print("[spike] motion: Finder window (osascript)")
        return
    print("[spike] motion: no generator available; move a window manually")


def stop_motion():
    if motion_proc and motion_proc.poll() is None:
        motion_proc.terminate()


def finish(code):
    stop_motion()
    try:
        rpc({"id": "z", "method": "control.shutdown"})
    except Exception:
        pass
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    print(f"[spike] helper exit rc={proc.returncode}")
    if not IS_WINDOWS:
        try:
            os.unlink(control_path)
        except FileNotFoundError:
            pass
    sys.exit(code)


deadline = time.time() + 20
while time.time() < deadline:
    if proc.poll() is not None:
        print(f"[spike] helper exited early rc={proc.returncode}")
        sys.exit(1)
    if control_ready():
        try:
            print("[spike] ping ->", rpc({"id": "0", "method": "control.ping"}))
            break
        except Exception:
            time.sleep(0.2)
    else:
        time.sleep(0.2)
else:
    print("[spike] control channel never came up")
    proc.kill()
    sys.exit(1)

list_reply = rpc({"id": "1", "method": "screen.list"})
print("[spike] screen.list ->", list_reply)
if args.list_only:
    print("[spike] state.get.screen_capture ->", json.loads(rpc({"id": "1a", "method": "state.get"})).get("result", {}).get("screen_capture"))
    finish(0)

print("[spike] camera off ->", rpc({"id": "2", "method": "program.update", "section": "camera",
                                     "values": {"enabled": False, "mirror": False}}))
print("[spike] vcam.raw.start ->", rpc({"id": "3", "method": "output.vcam.raw.start"}))

mj = socket.create_connection(("127.0.0.1", args.preview_port), timeout=10)
mj.sendall(b"GET /preview.mjpg HTTP/1.1\r\nHost: localhost\r\n\r\n")
mj_latest = [None]
mj_count = [0]
stop_flag = [False]


def mj_reader():
    buf = bytearray()
    while not stop_flag[0]:
        try:
            chunk = mj.recv(1 << 20)
        except Exception:
            break
        if not chunk:
            break
        buf += chunk
        while True:
            i = buf.find(b"\r\n\r\n")
            if i < 0:
                break
            hdr = bytes(buf[:i]).decode(errors="replace")
            cl = None
            for hl in hdr.split("\r\n"):
                if hl.lower().startswith("content-length:"):
                    cl = int(hl.split(":", 1)[1].strip())
            if cl is None:
                del buf[:i + 4]
                continue
            if len(buf) < i + 4 + cl:
                break
            mj_latest[0] = bytes(buf[i + 4:i + 4 + cl])
            mj_count[0] += 1
            del buf[:i + 4 + cl]


threading.Thread(target=mj_reader, daemon=True).start()

capabilities = json.loads(list_reply).get("result", {}).get("capabilities", {})
started = None
if capabilities.get("system_picker"):
    if args.motion:
        start_motion(args.wait + args.measure + 30)
    t0 = time.time()
    print("[spike] screen.pick ->", rpc({"id": "4", "method": "screen.pick"}))
    print(f"[spike] >>> The system picker should now be visible. Pick a DISPLAY within {args.wait} s. <<<")
    while time.time() - t0 < args.wait:
        ev = events({"screen_capture_started", "screen_capture_picker"})
        started = next((e for e in ev if e.get("type") == "screen_capture_started"), None)
        if started or any(e.get("event") == "cancelled" for e in ev):
            break
        time.sleep(0.5)
elif capabilities.get("enumeration"):
    if not args.source:
        print("[spike] this platform needs --source <source_id> (see screen.list above)")
        finish(2)
    if args.motion:
        start_motion(args.measure + 30)
        time.sleep(1.5)
    print("[spike] screen.start ->", rpc({"id": "4", "method": "screen.start", "source_id": args.source, "include_cursor": True}))
    time.sleep(1.0)
    started = next((e for e in events({"screen_capture_started"})), None)
else:
    print("[spike] screen capture unsupported on this host:", capabilities)
    finish(2)

print("[spike] events so far:", json.dumps(events({"screen_capture_started", "screen_capture_picker", "screen_capture_error", "screen_capture_stopped", "screen_capture_source_changed"})))
print("[spike] state.get.screen_capture ->", json.loads(rpc({"id": "5", "method": "state.get"})).get("result", {}).get("screen_capture"))

if not started:
    print("[spike] capture did not start; stopping")
    print("[spike] screen.stop ->", rpc({"id": "6", "method": "screen.stop"}))
    time.sleep(1.0)
    print("[spike] events after stop:", json.dumps(events({"screen_capture_stopped", "screen_capture_picker", "screen_capture_error"})))
    stop_flag[0] = True
    finish(2)

if args.probe and not args.full:
    print("[spike] probe mode: capture started; stopping without measurement")
    print("[spike] screen.stop ->", rpc({"id": "6", "method": "screen.stop"}))
    time.sleep(1.0)
    print("[spike] events after stop:", json.dumps(events({"screen_capture_stopped"})))
    stop_flag[0] = True
    finish(0)

print("[spike] media_layer screen fullscreen ->", rpc({"id": "7", "method": "program.update", "section": "media_layer",
                                                          "values": {"enabled": True, "source": "screen", "mode": "fullscreen"}}))
time.sleep(2.0)

samples = []
prev = None
t_start = time.time()
while time.time() - t_start < args.measure:
    st = json.loads(rpc({"id": "8", "method": "state.get"})).get("result", {})
    now = time.time()
    rendered = st.get("rendered_frames") or 0
    captured = (st.get("screen_capture") or {}).get("captured_frames", 0)
    cpu = cpu_percent(proc.pid)
    if prev:
        dt = now - prev[0]
        samples.append({"t": round(now - t_start, 1), "render_fps": round((rendered - prev[1]) / dt, 1),
                        "capture_fps": round((captured - prev[2]) / dt, 1), "cpu": cpu,
                        "mjpeg_frames": mj_count[0]})
    prev = (now, rendered, captured)
    time.sleep(2.0)

if mj_latest[0]:
    with open(os.path.join(args.out, "share-fullscreen.jpg"), "wb") as f:
        f.write(mj_latest[0])
print("[spike] samples:", json.dumps(samples))
if len(samples) > 1:
    rf = [s["render_fps"] for s in samples[1:]]
    cf = [s["capture_fps"] for s in samples[1:]]
    cp = [s["cpu"] for s in samples[1:]]
    print(f"[spike] SUMMARY render_fps min/avg={min(rf)}/{round(sum(rf)/len(rf),1)} "
          f"capture_fps min/avg={min(cf)}/{round(sum(cf)/len(cf),1)} cpu min/max={min(cp)}/{max(cp)} mjpeg_frames={mj_count[0]}")
metrics = events({"screen_capture_metrics"})
if metrics:
    print("[spike] metrics events:", json.dumps(metrics[-3:]))
print("[spike] final state.get.screen_capture ->", json.loads(rpc({"id": "9", "method": "state.get"})).get("result", {}).get("screen_capture"))
print("[spike] pip ->", rpc({"id": "10", "method": "program.update", "section": "media_layer",
                              "values": {"enabled": True, "source": "screen", "mode": "pip",
                                         "x": 0.58, "y": 0.12, "width": 0.34, "height": 0.28}}))
time.sleep(2.0)
if mj_latest[0]:
    with open(os.path.join(args.out, "share-pip.jpg"), "wb") as f:
        f.write(mj_latest[0])
print("[spike] screen.stop ->", rpc({"id": "11", "method": "screen.stop"}))
time.sleep(1.5)
print("[spike] events after stop:", json.dumps(events({"screen_capture_stopped", "screen_capture_error"})))
stop_flag[0] = True
finish(0)

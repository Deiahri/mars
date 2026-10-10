# Ideas

Use this page as a lightweight place to capture thoughts, feature ideas, project concepts, and experiments.

## Quick capture

- [ ] Add idea
- [ ] Add idea
- [ ] Add idea

## Backlog

- 

## Experiments

### Motorcycle race game: body-controlled racing

A multiplayer racing game you ride with your body.

#### Controls

- Lean: MediaPipe Pose measures the angle of your shoulder line (or head offset from hip center). Lean left and the bike carves left.
- Throttle: MediaPipe Hands reads your right wrist roll like a real throttle grip. Twist forward for gas, back to ease off.
- Brake: left fist closed.

#### The mechanic that makes it a game: grip budget

Each bike has limited tire grip. Lean angle and throttle both draw from it, so leaning hard at full throttle makes you slide out and lose speed. Good riders brake late, lean in, and get back on the gas at the corner exit. That's real riding, and it gives skilled players a visible edge, so the judges' first attempt will be funny and their second will be competitive.

#### Two cheap extras

- Slipstream: ride close behind a rival for a speed boost, so the race creates overtakes.
- Spectator hazards: phones can drop oil slicks (if you want to keep the multiplayer-for-the-crowd angle).

#### Stack

- MediaPipe Tasks Vision (Pose + Hands) running in the browser on a laptop with a GPU delegate
- Canvas 2D top-down track (don't build pseudo-3D; it will eat your 24 hours)
- Node + Socket.IO: room codes and sending each player's position at about 20Hz; the server handles start, finish, and lap timing
- The Pi: running MediaPipe on it will likely be too slow. Use it as a physical lap-time scoreboard or a hardware start-light (red, red, green) driven by the server. That makes the physical setup part of the demo.

#### Risks and fixes

- Pose plus Hands together at 30fps might stutter. Smooth inputs with an exponential moving average and add a 5-second calibration ("sit neutral") to set zero lean.
- Framing: both your torso and hand must be visible, so sit about 1.5m back. Test it early, because this decides if the game works.
- Fallback if it's laggy: drop Pose and use one hand for everything—hand tilt is the lean, finger curl is the throttle. Less impressive, but it still works.

#### Build order

1. Webcam to lean angle plus throttle value on screen (about 3 hours, and this is the real risk)
2. Single-player bike on a loop track with the grip budget
3. Two-player rooms over Socket.IO with live positions
4. Lap timer, start lights, finish screen
5. Pi scoreboard and spectator hazards, only if there's time

## Notes

- 

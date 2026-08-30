# Soccer Game Time Tracker

A local prototype for tracking player time in a soccer game. Players can be dragged into the field/stage, and the app logs each segment of play in a SQLite database. When a player is removed from the stage, their segment is closed and the running total updates automatically.

## Features

- Drag player cards into the stage to log the start of a play segment
- Drag players back out of the stage to log the end of a play segment
- Track cumulative playing time for each player across multiple game segments
- Persist segment history in SQLite for a single game
- Frontend and backend running locally in a single Node.js app

## Requirements

- Node.js 18+
- npm

## Local setup

1. Install dependencies:
   npm install
2. Start the application:
   npm start
3. Open the app in a browser:
   http://localhost:3000

## Project structure

- `src/server.js` – Express server and API routes
- `src/db.js` – SQLite database setup and seed data
- `public/index.html` – app shell
- `public/styles.css` – styling for the roster and stage
- `public/app.js` – drag-and-drop logic and time updates

## Notes for GitHub

The app is ready to be pushed to a GitHub repository. If needed, create a new remote repository and run:

```bash
git init
git add .
git commit -m "Initial soccer game time tracker prototype"
git remote add origin <your-repository-url>
git push -u origin main
```

## Hosting plan

This prototype is designed to run locally and is simple enough to later move to a lightweight hosting environment such as Bluehost with a Node.js deployment setup.

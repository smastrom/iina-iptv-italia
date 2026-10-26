// Do not execute /usr/bin/python3 blindly: on a Mac without developer tools
// it can open Apple's developer-tools installer instead of running Python.
const CANDIDATES = [
  "/usr/local/bin/python3", // Official python.org graphical installer.
  "/opt/homebrew/bin/python3", // Reuse an existing Homebrew installation.
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/python3"
];

function findPython(file) {
  for (const candidate of CANDIDATES) {
    if (file.exists(candidate)) return candidate;
  }
  throw new Error("Per caricare la guida TV serve Python 3. Scarica l’installer per macOS da https://www.python.org/downloads/macos/, apri il file .pkg e completa l’installazione. Poi riavvia IINA. Non servono Xcode o comandi nel Terminale.");
}

module.exports = { findPython };

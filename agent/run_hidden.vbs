' Launches the agent with zero visible window — not even a flash.
' Edit the path below if you put this folder somewhere other than
' the default location suggested in SETUP.md.

Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
pythonw = scriptDir & "\venv\Scripts\pythonw.exe"
agent = scriptDir & "\agent.py"

shell.Run """" & pythonw & """ """ & agent & """", 0, False

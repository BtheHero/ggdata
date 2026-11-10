// Shared by the jobs: reads a saved JSON file by its property key, or returns the fallback
function psReadJson_(propKey, fallback) {
  const id = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!id) return fallback;
  try { return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString()); }
  catch (e) { Logger.log("Couldn't read " + propKey + ": " + e.message); return fallback; }
}

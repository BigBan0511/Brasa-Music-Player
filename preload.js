'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = ch => cb => {
  const fn = (e, data) => cb(data);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('brasa', {
  getLibrary: () => ipcRenderer.invoke('lib:get'),
  addFolders: () => ipcRenderer.invoke('lib:addFolders'),
  addFiles: () => ipcRenderer.invoke('lib:addFiles'),
  importPaths: paths => ipcRenderer.invoke('lib:importPaths', paths),
  rescan: () => ipcRenderer.invoke('lib:rescan'),
  removeTracks: ids => ipcRenderer.invoke('lib:removeTracks', ids),
  removeFolder: folder => ipcRenderer.invoke('lib:removeFolder', folder),
  saveState: part => ipcRenderer.send('state:save', part),
  prepare: (id, force) => ipcRenderer.invoke('media:prepare', id, !!force),
  analyze: id => ipcRenderer.invoke('media:analyze', id),
  reportDuration: (id, d) => ipcRenderer.invoke('media:duration', id, d),
  getLyrics: (id, online) => ipcRenderer.invoke('lyrics:get', id, !!online),
  pickLyrics: id => ipcRenderer.invoke('lyrics:pick', id),
  importPlaylists: () => ipcRenderer.invoke('pl:import'),
  exportPlaylist: (name, ids) => ipcRenderer.invoke('pl:export', name, ids),
  showInFolder: id => ipcRenderer.invoke('shell:show', id),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  setTheme: src => ipcRenderer.invoke('win:theme', src),
  setOverlay: o => ipcRenderer.send('win:overlay', o),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  onUpsert: on('lib:upsert'),
  onRemove: on('lib:remove'),
  onProgress: on('lib:progress'),
  onFolders: on('lib:folders'),
  onOpen: on('app:open')
});

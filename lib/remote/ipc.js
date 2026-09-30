'use strict';

/**
 * Desktop-only management of remote control. Token creation and revocation are
 * deliberately unavailable over the network, so a leaked token cannot mint more.
 * @param {Electron.IpcMain} ipcMain
 * @param {() => import('./index').RemoteControl} getRemote
 */
function registerRemoteIpc(ipcMain, getRemote) {
  ipcMain.handle('remote:get', () => getRemote().getState());
  ipcMain.handle('remote:configure', (_event, input) => getRemote().configure(input));
  ipcMain.handle('remote:create-token', (_event, input) => getRemote().createToken(input));
  ipcMain.handle('remote:revoke-token', (_event, id) => getRemote().revokeToken(id));
  ipcMain.handle('remote:clear-audit', () => getRemote().clearAudit());
}

module.exports = { registerRemoteIpc };

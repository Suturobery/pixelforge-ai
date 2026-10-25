import { Menu, app, type MenuItemConstructorOptions } from 'electron';

/**
 * Minimal application menu (v3.1 §12 Task 1 — window management).
 *
 * ACCELERATOR DISCIPLINE (evidence: inventory P0-T1-INV, use-keyboard.ts):
 * the prototype binds Ctrl/Cmd+S, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y,
 * B/E/F/L/R/I/M, 1–4, G, O, +/=/- and Space(pan). Menu items below are chosen
 * so NO accelerator collides with those bindings:
 *   - no Undo/Redo roles (they would swallow Ctrl+Z/Y and bypass the command bus)
 *   - no Save role (Ctrl+S belongs to the app)
 *   - zoom roles registered WITHOUT accelerators (Ctrl+0 fit is planned in §2.8)
 * When Task 5a adds Ctrl+X/C/V selection ops, set registerAccelerator:false there.
 */
export function installApplicationMenu(): void {
  const mac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [mac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom', registerAccelerator: false },
        { role: 'zoomIn', registerAccelerator: false },
        { role: 'zoomOut', registerAccelerator: false },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

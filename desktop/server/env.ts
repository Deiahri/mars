// The environment for the Python helpers (overlay.py, halo.py, targets.py).
//
// Started from a snap-packaged app (VS Code's terminal, for one), the environment points GTK, GIO
// and the C library at the snap's own copies. The system Python then crashes as soon as it loads
// GTK ("undefined symbol: __libc_pthread_init"). Drop those and restore what the snap saved.

const SNAP_VARS = [
  'GTK_PATH',
  'GTK_EXE_PREFIX',
  'GTK_IM_MODULE_FILE',
  'GDK_PIXBUF_MODULE_FILE',
  'GDK_PIXBUF_MODULEDIR',
  'GIO_MODULE_DIR',
  'GSETTINGS_SCHEMA_DIR',
  'LOCPATH',
];
const SAVED = '_VSCODE_SNAP_ORIG';

export function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Not gated on $SNAP: VS Code's terminal drops that but keeps the rest.
  for (const k of SNAP_VARS) if (env[k]?.includes('/snap/')) delete env[k];
  for (const [k, v] of Object.entries(env)) {
    if (!k.endsWith(SAVED)) continue;
    delete env[k];
    if (v) env[k.slice(0, -SAVED.length)] = v;
  }
  return env;
}

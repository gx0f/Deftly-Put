// Serve the upstream UMD builds only to the offline Draft.js test pages.
const files = new Map([
  ['react.js', require.resolve('react/umd/react.development.js')],
  ['react-dom.js', require.resolve('react-dom/umd/react-dom.development.js')],
  ['immutable.js', require.resolve('immutable/dist/immutable.js')],
  ['Draft.js', require.resolve('draft-js/dist/Draft.js')],
]);

function fixtureScript(name) {
  if (!files.has(name)) throw new Error('Unknown fixture script: ' + name);
  return files.get(name);
}

module.exports = {fixtureScript};

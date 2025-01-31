// webpack.config.mjs
export default {
  mode: 'development',
  entry: './public/chart.js',
  output: {
    filename: 'bundle.js',
    path: new URL('./dist', import.meta.url).pathname,
  },
};
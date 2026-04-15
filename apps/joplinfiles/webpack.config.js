const path = require('path')

module.exports = {
    entry: {
        joplinfiles: './src/joplinfiles.js',
    },
    output: {
        path:     path.resolve(__dirname, 'js'),
        filename: '[name].js',
    },
    resolve: {
        fallback: {
            path:   false,
            fs:     false,
            os:     false,
            stream: false,
        },
    },
}

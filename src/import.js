
const config = require('config');
const utils = require('./utils.js');
const logger = utils.getLogger();

process.on('uncaughtException', (err) => {
    logger.error('uncaught exception received:');
    logger.error(err.stack);
});

const run = async () => {
    try {
        const collection = await utils.connectDatabase();
        const count = await utils.doImport(config.get('importDir'), config.get('storagePath'), collection);
        logger.info(`import finished, ${count} files imported.`);
    } catch (error) {
        logger.error(error);
    }
    process.exit();
}
run();
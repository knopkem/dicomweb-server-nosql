const config = require('config');
const shell = require('shelljs');
const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');
const crypto = require('crypto');
const fastify = require('fastify')({ logger: false });
const { Readable } = require('stream');

// make sure default directories exist
shell.mkdir('-p', config.get('logDir'));
shell.mkdir('-p', config.get('storagePath'));

const utils = require('./utils.js');

fastify.register(require('fastify-static'), {
  root: path.join(__dirname, '../public')
});

fastify.register(require('fastify-cors'), { 
});

const logger = utils.getLogger();

let _collection = null;

// log exceptions
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception received:');
  logger.error(err.stack);
  process.exit(1);
});

//------------------------------------------------------------------

fastify.get('/rs/studies', async (req, reply) => {
  // fix for OHIF viewer assuming a lot of tags
  const tags = [
    '00080005',
    '00080020',
    '00080030',
    '00080050',
    '00080054',
    '00080056',
    '00080061',
    '00080090',
    '00081190',
    '00100010',
    '00100020',
    '00100030',
    '00100040',
    '0020000D',
    '00200010',
    '00201206',
    '00201208',
  ];

  const json = await utils.doFind('STUDY', req.query, tags, _collection);
  reply.send(json);
});

//------------------------------------------------------------------

fastify.get(
  '/viewer/rs/studies/:studyInstanceUid/metadata',
  async (req, reply) => {
    // fix for OHIF viewer assuming a lot of tags
    const tags = [
      '00080005',
      '00080054',
      '00080056',
      '00080060',
      '0008103E',
      '00081190',
      '0020000E',
      '00200011',
      '00201209',
    ];

    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;

    const json = await utils.doFind('SERIES', query, tags, _collection);
    reply.send(json);
  }
);

//------------------------------------------------------------------

fastify.get(
  '/viewer/rs/studies/:studyInstanceUid/series',
  async (req, reply) => {
    // fix for OHIF viewer assuming a lot of tags
    const tags = [
      '00080005',
      '00080054',
      '00080056',
      '00080060',
      '0008103E',
      '00081190',
      '0020000E',
      '00200011',
      '00201209',
    ];

    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;

    const json = await utils.doFind('SERIES', query, tags, _collection);
    reply.send(json);
  }
);

//------------------------------------------------------------------

fastify.get(
  '/viewer/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances',
  async (req, reply) => {
    // fix for OHIF viewer assuming a lot of tags
    const tags = [
        '00080016', 
        '00080018'
    ];

    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;
    query.SeriesInstanceUID = req.params.seriesInstanceUid;

    const json = await utils.doFind('IMAGE', query, tags, _collection);
    reply.send(json);
  }
);

//------------------------------------------------------------------

fastify.get(
  '/viewer/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/metadata',
  async (req, reply) => {
    // fix for OHIF viewer assuming a lot of tags
    const tags = [
      '00080016',
      '00080018',
      '00080060',
      '00280002',
      '00280004',
      '00280010',
      '00280011',
      '00280030',
      '00280100',
      '00280101',
      '00280102',
      '00280103',
      '00281050',
      '00281051',
      '00281052',
      '00281053',
      '00200032',
      '00200037',
    ];
    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;
    query.SeriesInstanceUID = req.params.seriesInstanceUid;

    const json = await utils.doFind('IMAGE', query, tags, _collection);
    reply.send(json);
  }
);

//------------------------------------------------------------------

fastify.get(
  '/viewer/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/frames/:frame',
  async (req, reply) => {
    const {
      studyInstanceUid,
      seriesInstanceUid,
      sopInstanceUid,
      frame,
    } = req.params;

    const storagePath = config.get('storagePath');
    const pathname = path.join(storagePath, studyInstanceUid, sopInstanceUid);

    try {
      // logger.info(studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame);
      await utils.fileExists(pathname);
    } catch (error) {
      logger.error(error);
      reply.code(404);
      reply.send(`File ${pathname} not found!`);
      return;
    }

    // read file from file system
    try {
      const data = await fs.promises.readFile(pathname);
      const dataset = dicomParser.parseDicom(data);
      const pixelDataElement = dataset.elements.x7fe00010;
      const buffer = Buffer.from(
        dataset.byteArray.buffer,
        pixelDataElement.dataOffset,
        pixelDataElement.length
      );

      const term = '\r\n';
      const boundary = crypto.randomBytes(16).toString('hex');
      const contentId = crypto.randomBytes(16).toString('hex');
      const endline = `${term}--${boundary}--${term}`;

      reply.header(
        'Content-Type',
        `multipart/related;start=${contentId};type='application/octed-stream';boundary='${boundary}'`
      );

      const readStream = new Readable({
        read() {
          this.push(`${term}--${boundary}${term}`);
          this.push(`Content-Location:localhost${term}`);
          this.push(`Content-ID:${contentId}${term}`);
          this.push(`Content-Type:application/octet-stream${term}`);
          this.push(term);
          this.push(buffer);
          this.push(endline);
          this.push(null);
        },
      });

      reply.send(readStream);
    } catch (error) {
      logger.error(error);
      reply.code(500);
      reply.send(`Error getting the file: ${error}.`);
    }
  }
);

//------------------------------------------------------------------

fastify.get('/viewer/wadouri/', async (req, reply) => {
  const studyUid = req.query.studyUID;
  const seriesUid = req.query.seriesUID;
  const imageUid = req.query.objectUID;
  if (!studyUid || !seriesUid || !imageUid) {
    const msg = `Error missing parameters.`;
    logger.error(msg);
    reply.code = 500;
    reply.send(msg);
    return;
  }
  const storagePath = config.get('storagePath');
  const pathname = path.join(storagePath, studyUid, imageUid);

  // if the file is found, set Content-type and send data
  reply.header(
    'Content-Type',
    'application/dicom'
  );


  // read file from file system
  fs.readFile(pathname, (err, data) => {
    if (err) {
      const msg = `Error getting the file: ${err}.`;
      logger.error(msg);
      reply.code = 500;
      reply.send(msg);
    }
    reply.send(data);
  });
});

//------------------------------------------------------------------

const port= config.get('webserverPort');
logger.info('starting...');
fastify.listen(port, async (err, address) => {
  if (err) {
    logger.error(err);
    process.exit(1);
  }
  logger.info(`web-server listening on port: ${port}`);
  _collection = await utils.connectDatabase();
});

//------------------------------------------------------------------

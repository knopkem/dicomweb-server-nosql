const dict = require("dicom-data-dictionary");
const fs = require("fs");
const dicom = require("dicom");
const MongoClient = require("mongodb").MongoClient;
const path = require('path');
const { storagePath } = require("../config/default");
const shell = require('shelljs');
const dictionary = new dict.DataElementDictionary();

// create a rolling file logger based on date/time that fires process events
const opts = {
  errorEventName: "error",
  logDirectory: "./logs", // NOTE: folder must exist and be writable...
  fileNamePattern: "roll-<DATE>.log",
  dateFormat: "YYYY.MM.DD",
};
const manager = require("simple-node-logger").createLogManager();
// manager.createConsoleAppender();
manager.createRollingFileAppender(opts);
const logger = manager.createLogger();

async function* getFiles(dir) {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const res = path.resolve(dir, dirent.name);
      if (dirent.isDirectory()) {
        yield* getFiles(res);
      } else {
        yield res;
      }
    }
  }

//------------------------------------------------------------------

const isHex = (name) => {
  return /^[0-9A-F]{8}$/.test(name);
};

//------------------------------------------------------------------

const findDicomName = (name) => {
  // optimize: skip traversal if name is already a tag
  if (isHex(name)) {
    return name;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const key of Object.keys(dict.standardDataElements)) {
    const value = dict.standardDataElements[key];
    if (value.name === name) {
      return key;
    }
  }
  return undefined;
};

//------------------------------------------------------------------

const utils = {
  getLogger: () => {
    return logger;
  },
  connectDatabase: () => {
    const url = "mongodb://localhost:27017";
    const dbName = "archive";

    return new Promise((resolve, reject) => {
      MongoClient.connect(url, { useUnifiedTopology: true }, (err, client) => {
        if (err) {
          logger.error(err);
          reject(err);
        }

        logger.info("Connected successfully to mongodb server");
        const db = client.db(dbName);
        // create our collection
        const collection = db.collection("documents");
        // create unique index based on sop instance uid
        collection.createIndex(
          {
            "00080018": 1,
          },
          {
            unique: true,
          }
        );

        resolve(collection);
      });
    });
  },
  fileExists: (pathname) => {
    return new Promise((resolve, reject) => {
      fs.access(pathname, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },
  doFind: (queryLevel, query, defaults, collection) => {
    const tags = [];

    // add search param
    Object.keys(query).forEach((propName) => {
      const tag = findDicomName(propName);
      if (tag) {
        let v = query[propName];
        tags.push({ key: tag, value: v });
      }
    });

    // run query on mongo db and return json response
    return new Promise((resolve) => {
      const queries = [];
      const attributes = defaults;
      tags.forEach((tag) => {
        const attribute = tag.key;
        attributes.push(attribute);
        const element = dictionary.lookup(attribute);
        const prop = attribute + ".Value";
        let query = {};

        // filter out all tags that do not have a direct mapping to a file attribute (e.g. ModalitiesInStudy)
        // todo: add missing
        const modalitiesInStudy = "00080061";
        if (attribute === modalitiesInStudy) {
          query["00080060.Value"] = {
            $elemMatch: { $regex: tag.value, $options: "i" },
          };
        }
        // work around PN syntax that differs from normal use
        else if (element.vr === "PN") {
          const value = tag.value.replace("*", ".*");
          query[prop] = {
            $elemMatch: { Alphabetic: { $regex: value, $options: "i" } },
          };
        }
        // handle date ranges
        else if (
          element.vr === "DA" ||
          element.vr === "TM" ||
          element.vr === "DT"
        ) {
          const range = tag.value.split("-");
          query[prop] = { $elemMatch: { $gte: range[0], $lte: range[1] } };
        } else {
          query[prop] = { $elemMatch: { $regex: tag.value, $options: "i" } };
        }
        queries.push(query);
      });

      // no perform search
      collection.find({ $and: queries }).toArray((err, docs) => {
        if (err) {
          logger.error(err);
          reject(err);
        }

        // remove duplicate for level
        const seen = new Set();
        let id = "0020000D";
        if (queryLevel === "SERIES") {
          id = "0020000E";
        } else if (queryLevel === "IMAGE") {
          id = "00080018";
        }
        const unique = docs.filter((el) => {
          if (!el[id]) return false;
          const v = el[id].Value[0];
          const duplicate = seen.has(v);
          seen.add(v);
          return !duplicate;
        });

        // remove all results not requested
        const result = [];
        unique.forEach((doc) => {
          const filtered = Object.keys(doc)
            .filter((key) => attributes.includes(key))
            .reduce((obj, key) => {
              obj[key] = doc[key];
              return obj;
            }, {});
          result.push(filtered);
        });

        // finally return result
        //logger.info(result);
        resolve(result);
      });
    });
  },
  async doImport(sourcePath, targetPath, collection, ) {
    return new Promise( async (resolve, reject) => {

        let count = 0;
        for await (const file of getFiles(sourcePath)) {
            logger.info(`parsing ${file}`);
            try {
                json = await this.parseDicom(file);
            } catch (error) {
                logger.error(error);
            }
            if (json) {
                const studyUID = json['0020000D'].Value[0];
                const sopUID = json['00080018'].Value[0];
                const studyDirectory = path.join(targetPath, studyUID);
                shell.mkdir('-p', studyDirectory);
                const outFile = path.join(studyDirectory, sopUID);
                // copy file
                fs.createReadStream(file).pipe(fs.createWriteStream(outFile));
                // insert into db
                collection.insertOne(json, (err, result) => {
                if (err) {
                    logger.error(err);
                } else {
                    count++;
                }
                });
            }
        }
        resolve(count);
    });
  },
  parseDicom(filename) {
    return new Promise((resolve, reject) => {
        try {
            const decoder = dicom.decoder({ guess_header: true });
            const encoder = new dicom.json.JsonEncoder();
            const sink = new dicom.json.JsonSink((err, json) => {
              if (err) {
                logger.error(err);
                reject(err);
              }
              logger.info(
                "DICOM file successfully parsed. Now inserting into mongo db."
              );
              console.log('resolving');
              resolve(json);
            });
            fs.createReadStream(filename)
              .pipe(decoder)
              .pipe(encoder)
              .pipe(sink);
        } catch (error) {
            reject(error);
        }

    });
  },
};
module.exports = utils;

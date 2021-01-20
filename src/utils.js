const dict = require("dicom-data-dictionary");
const rra = require("recursive-readdir-async");
const config = require("config");
const fs = require("fs");
const fsPromises = require('fs').promises;
const path = require("path");
const dicom = require("dicom");
const { MongoClient } = require("mongodb");
const manager = require("simple-node-logger").createLogManager();

const dictionary = new dict.DataElementDictionary();
let logger = null;

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
    if (!logger) {
      const logDirectory = config.get("logDir");
      utils.mkdir(logDirectory);
      logger = manager.createLogger();
      // create a rolling file logger based on date/time that fires process events
      const opts = {
        errorEventName: "error",
        logDirectory, // NOTE: folder must exist and be writable...
        fileNamePattern: "roll-<DATE>.log",
        dateFormat: "YYYY.MM.DD",
      };
      manager.createRollingFileAppender(opts);
    }
    return logger;
  },
  connectDatabase: () => {
    const url = "mongodb://localhost:27017";
    const dbName = "archive";

    utils.mkdir(config.get("storagePath"));
    utils.mkdir(config.get("importDir"));

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
  mkdir: (filepath) => {
    if (!fs.existsSync(filepath)) {
      fs.mkdirSync(filepath, "0777", true);
    }
  },
  doFind: (queryLevel, query, defaults, collection) => {
    const tags = [];

    // add search param
    Object.keys(query).forEach((propName) => {
      const tag = findDicomName(propName);
      if (tag) {
        const v = query[propName];
        tags.push({ key: tag, value: v });
      }
    });

    // run query on mongo db and return json response
    return new Promise((resolve, reject) => {
      const queries = [];
      const attributes = defaults;
      tags.forEach((tag) => {
        const attribute = tag.key;
        attributes.push(attribute);
        const element = dictionary.lookup(attribute);
        const prop = `${attribute}.Value`;
        const findQuery = {};

        // filter out all tags that do not have a direct mapping to a file attribute (e.g. ModalitiesInStudy)
        // todo: add missing
        const modalitiesInStudy = "00080061";
        if (attribute === modalitiesInStudy) {
          findQuery["00080060.Value"] = {
            $elemMatch: { $regex: tag.value, $options: "i" },
          };
        }
        // work around PN syntax that differs from normal use
        else if (element.vr === "PN") {
          const value = tag.value.replace("*", ".*");
          findQuery[prop] = {
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
          findQuery[prop] = { $elemMatch: { $gte: range[0], $lte: range[1] } };
        } else {
          findQuery[prop] = {
            $elemMatch: { $regex: tag.value, $options: "i" },
          };
        }
        queries.push(findQuery);
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
              const newObj = obj;
              newObj[key] = doc[key];
              return newObj;
            }, {});
          result.push(filtered);
        });

        // finally return result
        // logger.info(result);
        resolve(result);
      });
    });
  },
  insertOne: (collection, json) => {
    return new Promise((resolve, reject) => {
        collection.insertOne(json, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
  },
  doImport: async (sourcePath, targetPath, collection) => {
      const list = await rra.list(sourcePath);

      const parsePromises = [];
      list.forEach((item) => {
          if (!item.isDirectory) {
            parsePromises.push(utils.parseDicom(item.fullname));
          }
      });
      const results = await Promise.all(parsePromises);

      const copyPromises = [];
      const insertPromises = [];
      results.forEach((json) => {

        logger.info(`copying file to archive directory.`);
        const studyUID = json['0020000D'].Value[0];
        const sopUID = json['00080018'].Value[0];
        const studyDirectory = path.join(targetPath, studyUID);
        utils.mkdir(studyDirectory);
        const outfile = path.join(studyDirectory, sopUID);
        // copy file
        copyPromises.push(fsPromises.copyFile(json.filepath, outfile));

        // insert into db
        logger.info(`inserting json into mongo db.`);
        insertPromises.push(utils.insertOne(collection, json));
        copyPromises.push(utils.insertOne(collection, json));
      });
      const res = await Promise.all(insertPromises); 
      return res.length;
  },
  parseDicom: (filename) => {
    logger.info(`Parsing DICOM file (${filename}).`);
    return new Promise((resolve, reject) => {
      try {
        const decoder = dicom.decoder({ guess_header: true });
        const encoder = new dicom.json.JsonEncoder();
        const sink = new dicom.json.JsonSink((err, json) => {
          if (err) {
            logger.error(err);
            reject(err);
          }
          logger.info(`DICOM file (${filename}) successfully parsed.`);
          // eslint-disable-next-line no-param-reassign
          json.filepath = filename;
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

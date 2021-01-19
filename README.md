# dicomweb-server-nosql

An easy to use DICOMWEB server with mongo db backend

## Description
* A nodejs server including a DICOM viewer (OHIF) connected via DICOMWEB (QIDO-RS and WADO-RS).
* Comes with preinstalled OHIF DICOM Web Viewer (version 4.5.12).
* Supports OHIF MPR (vtk.js) feature for viewing volumetric datasets
* mongodb backend

## Prerequisite

* nodejs 12 or newer
* mongodb installed

## Setup Instructions

* clone repository and install dependencies  
  ```npm install```

* update config file located in:  
  ```./config```

* copy dicom files to import directory (see config)

* import DICOM images:
  ```npm run import```

* run:  
  ```npm start```

* open webbrowser and start viewing  
  ```http://localhost:5000```

## License
MIT

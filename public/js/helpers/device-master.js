define([
    'jquery',
    'helpers/i18n',
    'helpers/sprintf',
    'app/actions/alert-actions',
    'app/actions/progress-actions',
    'app/constants/progress-constants',
    'app/actions/input-lightbox-actions',
    'app/constants/device-constants',
    'helpers/api/control',
    'helpers/api/3d-scan-control',
    'helpers/api/touch',
    'helpers/api/discover',
    'helpers/api/config',
    'app/actions/global-actions',
    'app/constants/input-lightbox-constants',
    'helpers/device-list',
    'helpers/api/camera',
    'helpers/array-findindex'
], function(
    $,
    i18n,
    sprintf,
    AlertActions,
    ProgressActions,
    ProgressConstants,
    InputLightboxActions,
    DeviceConstants,
    DeviceController,
    ScanController,
    Touch,
    Discover,
    Config,
    GlobalActions,
    InputLightBoxConstants,
    DeviceList,
    Camera
) {
    'use strict';

    let lang = i18n.get(),
        thisProgress,
        lastProgress,
        defaultPrinter,
        defaultPrinterWarningShowed = false,
        _instance = null,
        _password = '',
        _status = DeviceConstants.READY,
        _selectedDevice = {},
        _deviceNameMap = {},
        _device,
        _cameraTimeoutTracker,
        nwConsole,
        _devices = [],
        _errors = {};

    function selectDevice(device, deferred) {
        Object.assign(_selectedDevice, device);
        let d = deferred || $.Deferred(),
            uuid = device.uuid,
            goAuth = function(uuid) {
                ProgressActions.close();
                InputLightboxActions.open('auth', {
                    caption      : sprintf(lang.input_machine_password.require_password, _device.name),
                    inputHeader  : lang.input_machine_password.password,
                    confirmText  : lang.input_machine_password.connect,
                    type: InputLightBoxConstants.TYPE_PASSWORD,
                    onSubmit     : function(password) {
                        auth(uuid, password).done(function(data) {
                            selectDevice(device, d);
                        }).
                        fail(function(response) {
                            let message = (
                                false === response.reachable ?
                                lang.select_printer.unable_to_connect :
                                lang.select_printer.auth_failure
                            );

                            goAuth(uuid);

                            AlertActions.showPopupError('device-auth-fail', message);
                        });
                    }
                });
            };

        ProgressActions.open(ProgressConstants.NONSTOP);

        if(_existConnection(uuid)) {
            _device = _switchDevice(uuid);
            d.resolve(DeviceConstants.CONNECTED);
        }
        else {
            _device = {};
            _device.uuid = uuid;
            _device.name = device.name;
            _device.actions = DeviceController(uuid, {
                onConnect: function(response) {
                    d.notify(response);

                    if (response.status.toUpperCase() === DeviceConstants.CONNECTED) {
                        d.resolve(DeviceConstants.CONNECTED);
                        _devices.push(_device);
                    }
                },
                onError: function(response) {
                    ProgressActions.close();
                    // TODO: shouldn't do replace
                    response.error = response.error.replace(/^.*\:\s+(\w+)$/g, '$1');
                    switch (response.error.toUpperCase()) {
                    case DeviceConstants.TIMEOUT:
                        d.resolve(DeviceConstants.TIMEOUT);
                        break;
                    case DeviceConstants.AUTH_ERROR:
                    case DeviceConstants.AUTH_FAILED:
                        if (true === device.password) {
                            goAuth(_device.uuid);
                        }
                        else {
                            AlertActions.showPopupInfo(
                                'auth-error-with-diff-computer',
                                lang.message.no_password.content,
                                lang.message.no_password.caption
                            );
                        }
                        break;
                    case DeviceConstants.MONITOR_TOO_OLD:
                        AlertActions.showPopupError(
                            'fatal-occurred',
                            lang.message.monitor_too_old.content,
                            lang.message.monitor_too_old.caption
                        );
                        break;
                    default:
                        AlertActions.showPopupError(
                            'unhandle-exception',
                            lang.message.unknown_error
                        );
                    }
                }
            });
        }

        return d.always(function() {
            ProgressActions.close();
        }).promise();
    }

    function auth(uuid, password) {
        ProgressActions.open(ProgressConstants.NONSTOP);

        let d = $.Deferred(),
            closeProgress = function() {
                ProgressActions.close();
            },
            opts = {
                onError: function(data) {
                    d.reject(data);
                    closeProgress();
                },
                onSuccess: function(data) {
                    d.resolve(data);
                    closeProgress();
                },
                onFail: function(data) {
                    d.reject(data);
                    closeProgress();
                }
            };

        Touch(opts).send(uuid, password);

        return d.promise();
    }

    function uploadFile(blob, file, uploadPath, callback) {
        let d = $.Deferred();
        if(uploadPath) {
            ProgressActions.open(ProgressConstants.STEPPING, lang.device.starting, '', false);
            _device.actions.uploadToDirectory(blob, uploadPath, file.name, uploadProgress).then(function(result) {
                ProgressActions.close();
                d.resolve(result);
            });
        }
        else {
            _device.print = _device.actions.upload(blob.size, blob, {
                onFinished: function(result) {
                    d.resolve(result);
                }
            }, function(step, total) {
                thisProgress = parseInt(step / total * 100);
                if(thisProgress !== lastProgress) {
                    callback(parseInt(step / total * 100));
                    lastProgress = thisProgress;
                }
            });
        }

        return d.promise();
    }

    function uploadProgress(step, total) {
        thisProgress = parseInt(step / total * 100);
        if(thisProgress !== lastProgress) {
            // update every 20%
            if(parseInt(step / total * 100) % 20 === 0) {
                console.log('update', parseInt(step / total * 100));
                ProgressActions.updating(lang.device.uploading, parseInt(step / total * 100));
            }
            if(parseInt(step / total * 100) === 100) {
                ProgressActions.updating(lang.device.please_wait, 100);
            }
            lastProgress = thisProgress;
        }

    }

    function go(blob, callbackProgress) {
        let d = $.Deferred();
        if(!blob) {
            d.resolve(DeviceConstants.READY);
        }
        else {
            _go(blob, callbackProgress).then(function(status) {
                d.resolve(status);
            });
        }

        return d.promise();
    }

    function _go(blob, callback) {
        let d = $.Deferred();
        uploadFile(blob, null, null, callback).then(function() {
            d.resolve(_status);
        });
        return d.promise();
    }

    function goFromFile(path, fileName) {
        let d = $.Deferred();
        _device.actions.select(path, fileName).then(function(selectResult) {
            if(selectResult.status.toUpperCase() === DeviceConstants.OK) {
                _device.actions.start().then(function(startResult) {
                    d.resolve(startResult);
                });
            }
            else {
                d.resolve({status: 'error'});
            }
        });
        return d.promise();
    }

    function clearConnection() {
        let d = $.Deferred();

        getReport().then(function(report) {
            if(report.st_label === DeviceConstants.COMPLETED) {
                this.quit().then(function() {
                    d.resolve(DeviceConstants.READY);
                });
            }
            else {
                d.resolve(DeviceConstants.READY);
            }
        }.bind(this));

        return d.promise();
    }

    function resume() {
        return _do(DeviceConstants.RESUME);
    }

    function pause() {
        return _do(DeviceConstants.PAUSE);
    }

    function stop() {
        return _do(DeviceConstants.STOP);
    }

    function quit() {
        return _do(DeviceConstants.QUIT);
    }

    function quitTask() {
        return _do(DeviceConstants.QUIT_TASK);
    }

    function kick() {
        return _do(DeviceConstants.KICK);
    }

    function ls(path) {
        let d = $.Deferred();
        _device.actions.ls(path).then(function(result) {
            d.resolve(result);
        });
        return d.promise();
    }

    function fileInfo(path, fileName) {
        return _device.actions.fileInfo(path, fileName);
    }

    function deleteFile(path, fileName) {
        let fileNameWithPath = `${path.join('/')}/${fileName}`;
        return _device.actions.deleteFile(fileNameWithPath);
    }

    function downloadFile(path, fileName, callbackProgress) {
        let fileNameWithPath = `${path.join('/')}/${fileName}`;
        return _device.actions.downloadFile(fileNameWithPath, callbackProgress);
    }

    function readyCamera() {
        let d = $.Deferred();
        _device.scanController = ScanController(_device.uuid, {
            onReady: function() {
                d.resolve('');
            },
            onError: function(error) {
                AlertActions.showPopupError('', error);
            }
        });

        return d.promise();
    }

    function maintain(type) {
        return _device.actions.maintain(type);
    }

    function reconnect() {
        _devices.some(function(device, i) {
            if(device.uuid === _selectedDevice.uuid) {
                _devices.splice(i, 1);
            }
        });

        return selectDevice(_selectedDevice);
    }

    // set functions

    function setPassword(password) {
        _password = password;
    }

    // get functions

    function getReport() {
        return _do(DeviceConstants.REPORT);
    }

    function getSelectedDevice() {
        return _device;
    }

    function getPreviewInfo() {
        let d = $.Deferred();
        _device.actions.getPreview().then(function(result) {
            d.resolve(result);
        });
        return d.promise();
    }

    function getFirstDevice() {
        for(let i in _deviceNameMap) {
            return i;
        }
    }

    function getDeviceByName(name) {
        return _deviceNameMap[name];
    }

    function getDeviceByNameAsync(name, config) {
        if(getDeviceByName(name)){
            config.onSuccess(getDeviceByName(name));
            return;
        }
        if(config.timeout > 0){
            setTimeout(function(){
                config.timeout -= 500;
                getDeviceByNameAsync(name, config);
            },500);
        }else{
            config.onTimeout();
        }
    }

    function updateFirmware(file) {
        return _device.actions.fwUpdate(file);
    }

    function updateToolhead(file) {
        return _device.actions.toolheadUpdate(file).then(function() {
            _device.actions.quitTask();
        });
    }

    function headinfo() {
        return _device.actions.headinfo();
    }

    function closeConnection() {
        _device.actions.connection.close();
        _removeConnection(_device.uuid);
    }

    // Private Functions

    function _do(command) {
        let d = $.Deferred(),
            actions;

        actions =  {

            'RESUME': function() {
                _device.actions.resume().then(function() {
                    d.resolve('');
                });
            },

            'PAUSE': function() {
                _device.actions.pause().then(function() {
                    d.resolve('');
                });
            },

            'STOP': function() {
                _device.actions.abort().then(function() {
                    _status = DeviceConstants.READY;
                    d.resolve('');
                });
            },

            'QUIT': function() {
                let _getReport = function(result) {
                        getReport().done(function(response) {
                            if (0 >= retryTimes) {
                                d.fail(result);
                                return;
                            }

                            if (response.st_id === DeviceConstants.status.IDLE) {
                                d.resolve(result);
                            }
                            else {
                                _getReport(result);
                                retryTimes -= 1;
                            }
                        });
                    },
                    retryTimes = 10;

                _device.actions.quit().then(function(result) {
                    _getReport(result);
                });
            },

            'KICK': function() {
                _device.actions.reset().then(function(result) {
                    d.resolve(result);
                });
            },

            'QUIT_TASK': function() {
                _device.actions.quitTask().then(function(result) {
                    d.resolve(result);
                });
            },

            'REPORT': function() {
                _device.actions.report({
                    onFinished: function(report) {
                        if(typeof(report) === 'string') {
                            report = report.replace(/NaN/g,'');
                            d.resolve(JSON.parse(report));
                        }
                        else {
                            d.resolve(report);
                        }
                    }
                });
            }
        };

        actions[command]();
        return d.promise();
    }

    function updateNWProgress(deviceStatus) {
        if(FLUX.isNW) {
            if(!nwConsole) {
                nwConsole = nw.Window.get();
            }
            let stId = deviceStatus.st_id;
            if(stId !== 0 && stId !== 64 && stId !== 128) {
                if(deviceStatus.st_prog) {
                    nwConsole.setProgressBar(-1);
                    nwConsole.setProgressBar(deviceStatus.st_prog);
                }
            }
            else if (stId === 64 || stId == 128) {
                nwConsole.setProgressBar(-1);
            }
        }
    }

    function _isPrinting() {
        return _status === DeviceConstants.RUNNING;
    }

    function _existConnection(uuid) {
        return _devices.some(function(d) {
            return d.uuid === uuid;
        });
    }

    function _removeConnection(uuid) {
        let index = _devices.findIndex(function(d) {
            return d.uuid === uuid;
        });

        if (-1 < index) {
            _devices.splice(index, 1);
        }
    }

    function _switchDevice(uuid) {
        let index = _devices.findIndex(function(d) {
            return d.uuid === uuid;
        });

        return _devices[index];
    }

    function streamCamera(uuid) {
        let cameraStream = new Rx.Subject(),
            timeToReset = 20000;

        const initCamera = () => {
            _device.camera = Camera(uuid);
            _device.camera.startStream((imageBlob) => {
                processCameraResult(imageBlob);
            });
        };

        const resetCamera = () => {
            _device.camera.closeStream();
            initCamera();
        };

        const processCameraResult = (imageBlob) => {
            clearTimeout(_cameraTimeoutTracker);
            _cameraTimeoutTracker = setTimeout(resetCamera, timeToReset);
            cameraStream.onNext(imageBlob);
        };

        initCamera();
        _cameraTimeoutTracker = setTimeout(resetCamera, timeToReset);

        return cameraStream;
    }

    function stopStreamCamera() {
        if(_device.camera) {
            clearTimeout(_cameraTimeoutTracker);
            _device.camera.closeStream();
        }
    }

    function calibrate() {
        let d = $.Deferred();
        _device.actions.calibrate().then((response) => {
            d.resolve();
        }, (error) => {
            error = error || {};
            if(error.info === DeviceConstants.RESOURCE_BUSY) {
                AlertActions.showPopupError('device-busy', lang.calibration.RESOURCE_BUSY);
            }
            else {
                AlertActions.showPopupError('device-busy', error.error);
            }
            console.log('error from calibration', error);
            d.resolve();
        });
        return d.promise();
    }

    function _scanDeviceError(devices) {
        devices.forEach(function(device) {
            if(typeof(_errors[device.serial]) === 'string')  {
                if(_errors[device.serial] !== device.error_label && device.error_label) {
                    if(window.debug) {
                        AlertActions.showError(device.name + ': ' + device.error_label);
                        _errors[device.serial] = device.error_label;
                    }
                }
                else if(!device.error_label) {
                    _errors[device.serial] = '';
                }
            }
            else {
                _errors[device.serial] = '';
            }
            if(defaultPrinter) {
                if(defaultPrinter.serial === device.serial) {
                    if(
                        device.st_id === DeviceConstants.status.PAUSED_FROM_RUNNING ||
                        device.st_id === DeviceConstants.status.COMPLETED ||
                        device.st_id === DeviceConstants.status.ABORTED
                    ) {
                        if(!defaultPrinterWarningShowed) {
                            let message = '';
                            if(device.st_id === DeviceConstants.status.COMPLETED) {
                                message = `${lang.device.completed}`;
                            }
                            else if(device.st_id === DeviceConstants.status.ABORTED) {
                                message = `${lang.device.aborted}`;
                            }
                            else {
                                message = `${lang.device.pausedFromError}`;
                            }

                            if(device.st_id === DeviceConstants.status.COMPLETED) {
                                AlertActions.showInfo(message, function(growl) {
                                    growl.remove(function() {});
                                    selectDevice(defaultPrinter).then(function() {
                                        GlobalActions.showMonitor(defaultPrinter);
                                    });
                                }, true);
                            }
                            else {
                                AlertActions.showWarning(message, function(growl) {
                                    growl.remove(function() {});
                                    selectDevice(defaultPrinter).then(function() {
                                        GlobalActions.showMonitor(defaultPrinter);
                                    });
                                }, true);
                            }

                            defaultPrinterWarningShowed = true;

                            if(Config().read('notification') === '1') {
                                Notification.requestPermission((permission) => {
                                    if(permission === 'granted') {
                                        let notification = new Notification(device.name, {
                                            icon: '/img/icon-home-s.png',
                                            body: message
                                        });
                                    }
                                });
                            }
                        }
                    }
                    else {
                        if($('#growls').length > 0) {
                            AlertActions.closeNotification();
                            defaultPrinterWarningShowed = false;
                        }
                    }

                    updateNWProgress(device);
                }
            }
        });
    }

    // Core

    function DeviceSingleton() {
        if(_instance !== null) {
            throw new Error('Cannot instantiate more than one DeviceSingleton, use DeviceSingleton.get_instance()');
        }

        this.init();
    }

    DeviceSingleton.prototype = {
        init: function() {
            this.selectDevice           = selectDevice;
            this.uploadFile             = uploadFile;
            this.go                     = go;
            this.goFromFile             = goFromFile;
            this.resume                 = resume;
            this.pause                  = pause;
            this.stop                   = stop;
            this.quit                   = quit;
            this.quitTask               = quitTask;
            this.kick                   = kick;
            this.setPassword            = setPassword;
            this.getReport              = getReport;
            this.getSelectedDevice      = getSelectedDevice;
            this.readyCamera            = readyCamera;
            this.ls                     = ls;
            this.fileInfo               = fileInfo;
            this.deleteFile             = deleteFile;
            this.downloadFile           = downloadFile;
            this.getPreviewInfo         = getPreviewInfo;
            this.maintain               = maintain;
            this.reconnect              = reconnect;
            this.getDeviceByName        = getDeviceByName;
            this.getDeviceByNameAsync   = getDeviceByNameAsync;
            this.getFirstDevice         = getFirstDevice;
            this.updateFirmware         = updateFirmware;
            this.updateToolhead         = updateToolhead;
            this.headinfo               = headinfo;
            this.closeConnection        = closeConnection;
            this.streamCamera           = streamCamera;
            this.stopStreamCamera       = stopStreamCamera;
            this.calibrate              = calibrate;

            Discover(
                'device-master',
                function(devices) {
                    devices = DeviceList(devices);
                    for(let i in devices) {
                        _deviceNameMap[devices[i].name] = devices[i];
                    }
                    _scanDeviceError(devices);
                }
            );
        }
    };

    DeviceSingleton.get_instance = function() {
        if(_instance === null) {
            _instance = new DeviceSingleton();
        }
        defaultPrinter = Config().read('default-printer');
        return _instance;
    };

    return DeviceSingleton.get_instance();
});

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * resolver.js: periodically poll Triton's VMAPI for information about deployed
 * VMs.
 */

var mod_assert = require('assert-plus');
var mod_crypto = require('crypto');
var mod_uuid = require('uuid/v4');

var mod_util = require('util');

var FSM = require('mooremachine').FSM;
var VMAPI = require('sdc-clients').VMAPI;
var EventEmitter = require('events').EventEmitter;

function VmapiResolver(opts) {
	mod_assert.object(opts, 'opts');
	mod_assert.string(opts.url, 'opts.url');
	mod_assert.object(opts.tags, 'opts.tags');
	mod_assert.string(opts.tags.vm_tag_name, 'opts.tags.vm_tag_name');
	mod_assert.string(opts.tags.vm_tag_value, 'opts.tags.vm_tag_value');
	mod_assert.string(opts.tags.nic_tag, 'opts.tags.nic_tag');
	mod_assert.number(opts.backend_port, 'opts.backend_port');
	mod_assert.number(opts.pollInterval, 'opts.pollInterval');

	this.vmr_url = opts.url; /* VMAPI url */
	this.vmr_tags = opts.tags; /* VM and NIC tags */
	this.vmr_backend_port = opts.backend_port; /* backend listening port */
	this.vmr_pollInterval = opts.pollInterval; /* poll interval */
	this.vmr_log = opts.log.child({'component': 'VmapiResolver'});
	this.vmr_backends = {}; /* emitted backends */
	this.vmr_discovered_backends = [];  /* response from VMAPI */
	this.vmr_lastPoll = null; /* blocks setInterval() from piling up */
	this.vmr_regexp = new RegExp(this.vmr_tags.nic_tag);

	/* useful for debugging */
	this.vmr_lastBackends = {};
	this.vmr_lastAdded = [];
	this.vmr_lastRemoved = [];

	/* create VMAPI client */
	this.vmr_vmapi = new VMAPI({
		'url': this.vmr_url,
		'retry': {
			retries: 3,
			minTimeout: 2000,
			maxTimeout: 10000
		},
		'log': this.vmr_log.child({'component': 'VmapiClient'}),
		'agent': false
	});

	EventEmitter.call(this);
	FSM.call(this, 'stopped'); /* transition to 'stopped' state */
}
mod_util.inherits(VmapiResolver, FSM);

VmapiResolver.prototype.getBackends = function getBackends(cb) {
	var log = this.vmr_log;
	var vm_tag_name = this.vmr_tags.vm_tag_name;
	var vm_tag_value = this.vmr_tags.vm_tag_value;
	var nic_tag_regexp = this.vmr_regexp;
	var backends = [];

	/* create a 'tag.manta_role' or similar for filtering VMs */
	var tag_field = mod_util.format('tag.%s', vm_tag_name);

	var filter = {};
	filter['state'] = 'running';
	filter[tag_field] = vm_tag_value;

	/* find VMs */
	this.vmr_vmapi.listVms(filter, function (err, vms) {
		if (err) {
			cb(err);
			return;
		}
		Object.keys(vms).forEach(function (vm) {
			vms[vm].nics.forEach(function (nic) {
				/*
				 * nic tags are matched by the caller-provided
				 * regexp, e.g. 'manta.*'.
				 */
				if (nic_tag_regexp.test(nic.nic_tag)) {
					backends.push({
						'name': vms[vm].alias,
						'address': nic.ip
					});
				}
			});
		});
		log.info(backends, 'discovered backends');
		cb(null, backends);
	});
};

VmapiResolver.prototype.diffAndEmit = function diffAndEmit() {
	var self = this;
	var added = [];
	var removed = [];
	var new_backends = {};
	var old_backend;
	var found = false;
	var be;

	this.vmr_discovered_backends.forEach(function (backend) {
		be = {
			'name': backend.name,
			'address': backend.address,
			'port': self.vmr_backend_port
		};
		Object.keys(self.vmr_backends).forEach(function (key) {
			old_backend = self.vmr_backends[key];
			if (old_backend.address === be.address &&
			    old_backend.name === be.name) {
				found = true;
				be.key = key;
			}
		});
		if (!found) {
			be.key = mod_crypto.randomBytes(9).toString('base64');
			added.push(be.key);
		}
		new_backends[be.key] = be;
		found = false;
	});

	Object.keys(this.vmr_backends).forEach(function (k) {
		if (new_backends[k] === undefined) {
			removed.push(k);
		}
	});
	added.forEach(function (k) {
		self.emit('added', k, new_backends[k]);
	});
	removed.forEach(function (k) {
		self.emit('removed', k);
	});

	/* keep the backends from the last time we got a modification */
	if (added.length > 0 || removed.length > 0) {
		this.vmr_lastBackends = this.vmr_backends;
	}
	this.vmr_backends = new_backends; /* set the new backends */

	/* save the backends added/removed in this cycle for debugging */
	this.vmr_lastAdded = added;
	this.vmr_lastRemoved = removed;

	this.vmr_log.info({
		'added': added,
		'removed': removed
	}, 'backends modified');
};


VmapiResolver.prototype.state_stopped = function (S) {
	S.on(this, 'startAsserted', function () {
		S.gotoState('starting');
	});
};

VmapiResolver.prototype.state_starting = function (S) {
	S.on(this, 'failAsserted', function () {
		S.gotoState('failed');
	});

	var self = this;
	this.getBackends(function (err, backends) {
		if (err) {
			self.vmr_log.error(err, 'could not get backends');
			self.emit('failAsserted');
			return;
		}
		self.vmr_discovered_backends = backends;
		S.gotoState('running');
	});
};

VmapiResolver.prototype.state_running = function (S) {
	var self = this;
	this.diffAndEmit();

	var interval = setInterval(function () {
		if (self.vmr_lastPoll) {
			/* last poll is still running */
			return;
		}
		self.vmr_lastPoll = new Date().toISOString();
		self.getBackends(function (err, backends) {
			self.vmr_lastPoll = null;
			if (err) {
				self.vmr_log.error(err, 'could not get'
				    + ' backends');
				return;
			}
			self.vmr_discovered_backends = backends;
			self.diffAndEmit();
		});
	}, this.vmr_pollInterval);
	S.on(this, 'stopAsserted', function () {
		clearInterval(interval);
		S.gotoState('stopping');
	});
};

VmapiResolver.prototype.state_failed = function (S) {
	var self = this;

	var interval = setInterval(function () {
		if (self.vmr_lastPoll) {
			/* last poll is still running */
			return;
		}
		self.vmr_lastPoll = new Date().toISOString();
		self.getBackends(function (err, backends) {
			self.vmr_lastPoll = null;
			if (err) {
				self.vmr_log.error(err, 'could not get'
				    + ' backends');
				return;
			}
			self.vmr_log.info('successfully got backends,'
			    + ' transitioning to "running"');
			clearInterval(interval);
			self.vmr_discovered_backends = backends;
			S.gotoState('running');
		});
	}, this.vmr_pollInterval);

	S.on(this, 'stopAsserted', function () {
		clearInterval(interval);
		S.gotoState('stopping');
	});
};

VmapiResolver.prototype.state_stopping = function (S) {
	var self = this;
	var to_remove;
	var removed = [];

	/* remove all backends */
	Object.keys(this.vmr_backends).forEach(function (be) {
		to_remove = self.vmr_backends[be];
		self.emit('removed', to_remove['key']);
		removed.push(to_remove);
	});

	this.vmr_lastRemoved = removed;
	this.vmr_backends = {};
	S.immediate(function () {
		S.gotoState('stopped');
	});
};

VmapiResolver.prototype.start = function start() {
	mod_assert.ok(this.isInState('stopped'));
	this.emit('startAsserted');
};

VmapiResolver.prototype.stop = function stop() {
	mod_assert.ok(this.isInState('running') ||
	    this.isInState('failed'));
	this.emit('stopAsserted');
};

VmapiResolver.prototype.count = function count() {
	return (this.vmr_backends.length);
};

VmapiResolver.prototype.getLastError = function getLastError() {
	return (this.vmr_last_error);
};

VmapiResolver.prototype.list = function list() {
	return (this.vmr_backends);
};



module.exports = {
	VmapiResolver: VmapiResolver
};

# vmapi-resolver

This is a [node-cueball](https://github.com/joyent/node-cueball) Resolver which
uses VMAPI to discover backends.

vmapi-resolver periodically polls VMAPI for information about deployed virtual
machines. This is meant to be used as a library imported into a program that
uses node-cueball to manage connections.

If VMs with the given NIC and VM tags has its state transitioned to 'running',
it will be picked up by vmapi-resolver and emitted with an 'added' event. If
a VM that _was_ running leaves the 'running' state, vmapi-resolver will emit
a 'removed' event.

For more information on Cueball resolvers, see the Cueball
[documentation](https://joyent.github.io/node-cueball/#about_the_interface).

## Install

	npm install vmapi-resolver

## Example

This is a minimal example of how to use vmapi-resolver:

```javascript
var mod_resolver = require('vmapi-resolver');
var mod_bunyan = require('bunyan');

var log = mod_bunyan.createLogger({name: 'main'});
var resolver = new mod_resolver.VmapiResolver({
	'log': log,
	'url': 'http://vmapi.coal-1.example.com', /* VMAPI url */
	'pollInterval': 600000, /* poll VMAPI every 10 minutes */
	'tags': { /* NIC and VM tags */
		'vm_tag_name': 'manta_role',
		'vm_tag_value': '*postgres', /* VMAPI's wildcard matching */
		'nic_tag': 'manta.*' /* regexp-based match */
	},
	'backend_port': 5432 /* port number of the listening process */
});

resolver.on('added', function (key, backend) {
	log.info(backend, 'added');
});

resolver.on('removed', function (backend) {
	log.info(backend, 'removed');
});

resolver.start();
```

Each backend has a "tag" object that details the matched tag name and value from
the query to VMAPI, but only if an exact match can be found in the tag name
(i.e. no wildcard is used in "vm_tag_name").

## License

MPL v2. See the LICENSE file.

## Contributing

Contributions should be made via the [Joyent Gerrit](https://cr.joyent.us).
See the CONTRIBUTING file.

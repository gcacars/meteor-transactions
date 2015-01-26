// *******************************
// Transactions manager for Meteor
// by Brent Abrahams
// brent_abrahams@yahoo.com
// MIT Licence 2015
// *******************************
  
// This package adds one new mongo collection to your app
// It is exposed to the app via `tx.Transactions`, not via `Transactions`
// In much the same way that we have `Meteor.users` rather than `Users`

Transactions = new Mongo.Collection("transactions");

if (Meteor.isServer) {
  Transactions.allow({
	insert: function(userId, doc) { return (_.has(doc,"items") || doc.user_id !== userId) ? false : true; },
	update: function(userId, doc, fields, modifier) { 
	  if (userId !== doc.user_id) {
		// TODO -- this condition will need to be modified to allow an admin to look through transactions and undo/redo them from the client
		// That said, an admin interface shouldn't really be messing with the transactions collection from the client anyway, so ignoring this for now
		return false;
	  }
	  else {
		if (tx._checkTransactionFields(modifier)) {
		  return true;
		}
		else {
		  Transactions.remove({_id:doc._id});
		  return false; 
		}
	  }
	},
	remove: function(userId, doc) {
	  var fullDoc = Transactions.findOne({_id:doc._id});
	  return fullDoc && fullDoc.user_id === userId;
	}
  });
}

var Transact = function() {
  
  // ************************************************************************************************************
  // YOU CAN OPTINALLY OVERWRITE tx.collectionIndex TO MAKE THE UNDO/REDO STACK WORK FOR CERTAIN COLLECTIONS ONLY
  // ************************************************************************************************************
  
  // e.g. in a file shared by client and server, write:
  // tx.collectionIndex = {posts:Posts,comments:Comments, etc...}
  // where the key is the name of the database collection (e.g. 'posts') and the value is the actual Meteor Mongo.Collection object (e.g. Posts)
  // by default, all collections are added to tx.collectionIndex by default on startup in a "Meteor.startup(function(){ Meteor.defer(function() { ..." block
  // so if you are planning to overwrite tx.collectionIndex, you'll also need to wrap you code in "Meteor.startup(function(){ Meteor.defer(function() { ..." block
  // there's no real need to do this for most applications though
  
  this.collectionIndex = {};
  
  // ***********************************************************************************************  
  // YOU CAN OPTIONALLY OVERWRITE ANY OF THESE, ON CLIENT, SERVER OR BOTH (e.g. tx.logging = false;)
  // ***********************************************************************************************
   
  // Turn logging on or off
  
  this.logging = true;
  
  // By default, messages are logged to the console
  
  this.log = function() {if (this.logging) { _.each(arguments,function(message) {console.log(message);})}};
  
  // Because most/many db writes will come through the transaction manager, this is a good place to do some permission checking
  // NOTE: this permission check is the only thing standing between a user and the database if a transaction is committed from a method with no permission checks of its own
  // NOTE: this permission check will only be useful while simulating the method on the client, the real permission check will be courtesy of the allow/deny rules you set up on the server
  
  this.checkPermission = function(command,collection,doc,modifier) { return true; }; // commands are "insert", "update", "remove"
  
  // For the purpose of filtering transactions later, a "context" field is added to each transaction
  // By default, we don't do anything -- the context is empty, but there are probably certain fields in the document that we could record to use for filtering.
  // Remember, if there are multiple document being processed by a single transaction, the values from the last document in the queue will overwrite values for fields that have taken a value from a previous document - last write wins
  // OVERWRITING THIS WITH tx.makeContext = function() { ... } IS STRONGLY RECOMMENDED 
  
  this.makeContext = function(command,collection,doc,modifier) { return {}; };
  
  // If requireUser is set to false any non-logged in user gets the undo-redo stack of any non-logged-in user
  // For security purposes this should always be set to true in real apps
  
  this.requireUser = true;
  
  // Publish user's transactions from the last five minutes (publication not reactive - so it will be everything from 5 minutes before the user's last page refresh)
  // i.e. if the user doesn't refresh their page for 40 minutes, the last 45 minutes worth of their transactions will be published to the client
  
  this.undoTimeLimit = 5 * 60; // Number of seconds
  
  // This function is called on the client when the user tries to undo (or redo) a transaction in which some (or all) documents have been altered by a later transaction
  
  this.onTransactionExpired = function() {alert('Sorry. Other edits have been made, so this action can no longer be reversed.');};
  
  // If app code forgets to close a transaction on the server, it will autoclose after the following number of milliseconds
  // If a transaction is open on the client, it just stays open indefinitely
  
  this.idleTimeout = 5000;
  
  // By default, documents are hard deleted and a snapshot of the document the moment before deletion is stored for retrieval in the transaction document
  // This is much more prone to causing bugs and weirdness in apps, e.g. if a removed doc is restored after documents it depends on have been removed
  // (and whose removal should normally have caused the restored doc to have also been removed and tagged with the same transaction_id)
  // It's safer to turn softDelete on for complex apps, but having it off makes this package work out of the box better, as the user doesn't have to
  // use `,deleted:{$exists:false}` in their `find` and `findOne` selectors to keep deleted docs out of the result
  
  this.softDelete = false;
  
  // ***************************
  // DONT OVERWRITE ANY OF THESE
  // ***************************
  
  this._transaction_id = null;
  this._autoTransaction = false;
  this._executionStack = [];
  this._items = {};
  this._startAttempts = 0;
  this._rollback = false;
  this._rollbackReason = '';
  this._autoCancel = null;
  this._lastTransactionData = null;
  this._context = {};
  this._inverseOps = {
	'$set' : '$set',
	'$addToSet' : '$pull',
	'$unset' : '$set',
	'$pull' : '$addToSet',
	'$inc' : '$set',
	'$push' : '$set' // this is a buggy hack that will only work in certain simple scenarios -- using "$push" is NOT RECOMMENDED
  }
}

// **********
// PUBLIC API
// **********

// Starts a transaction

Transact.prototype.start = function(description) {
  if (tx.requireUser && !Meteor.userId()) {
	this.log('User must be logged in to start a transaction.');
	this._cleanReset();
	return;
  }
  this._resetAutoCancel();
  if (!this._transaction_id) {
	if (typeof description === 'undefined') {
	  description = 'last action';  
	}
	this._transaction_id = Transactions.insert({user_id:Meteor.userId(),timestamp:(new Date).getTime(),description:description});
	this.log('Started "' + description + '" with transaction_id: ' + this._transaction_id + ((this._autoTransaction) ? ' (auto started)' : ''));
	return this._transaction_id;
  }
  else {
	this.log('An attempt to start a transaction ("' + description + '") was made when a transaction was already open. Open transaction_id: ' + this._transaction_id);
	this._startAttempts++;
	return false;	
  }
}

// Checks whether a transaction is already started

Transact.prototype.transactionStarted = function() {
  return !!this._transaction_id;
}

// Commits all the changes queued in the current transaction

Transact.prototype.commit = function(txid,callback,newId) {
  if (tx.requireUser && !Meteor.userId()) {
	this.log('User must be logged in to commit a transaction.');
	return;
  }
  this._lastTransactionData = {};
  this._lastTransactionData.transaction_id = this._transaction_id;
  if (!this._transaction_id) {
	this._cleanReset();
	this.log("Commit reset transaction to clean state");
	this._callback(txid,callback,new Meteor.Error('no-transactions-open','No transaction open.'),false);
	return;	
  }
  if (!_.isFunction(txid) && typeof txid !== 'undefined' && txid !== this._transaction_id && _.isString(txid)) {
	if (txid === null) {
	  this.log("Forced commit");
	}
	else {
	  this._startAttempts--;
	  this._callback(txid,callback,new Meteor.Error('multiple-transactions-open','More than one transaction open. Closing one now to leave ' + this._startAttempts + ' transactions open.'),false);
	  return;
	}
  }
  if (this._startAttempts > 0 && !(!_.isFunction(txid) && typeof txid !== 'undefined' && (txid === this._transaction_id || txid === null))) {
	this._startAttempts--;
	this._callback(txid,callback,new Meteor.Error('multiple-transactions-open','More than one transaction open. Closing one now to leave ' + this._startAttempts + ' transactions open.'),false);
	return;	
  }
  if (_.isEmpty(this._items) && _.isEmpty(this._executionStack)) { // Have to do both checks in case of instant inserts that put nothing on this._executionStack but add to this._items
	// Don't record the transaction if nothing happened
	Transactions.remove({_id:this._transaction_id});
	this.log('Empty transaction removed: ' + this._transaction_id);
  }
  else if (this._rollback) {
	// One or more permissions failed or the transaction was cancelled, don't process the execution stack
	this.log('Incomplete transaction removed: ' + this._transaction_id);
	var error = this._rollbackReason;
	var errorDescription = '';
	switch (this._rollbackReason) {
	  case 'permission-denied' :
		errorDescription = 'One or more permissions were denied, so transaction was rolled back.';
		break;
	  case 'transaction-cancelled' :
		errorDescription = 'The transaction was cancelled programatically, so it was rolled back.';
		break;
	  default :
		errorDescription = 'An error occurred when processing an action.';
		suppressError = false;
		break;
	}
	this.rollback();
	this._callback(txid,callback,new Meteor.Error(error,errorDescription),false);
	return;
  }
  else {
	this.log('Beginning commit with transaction_id: ' + this._transaction_id);
	var newIdValues = [];
	// console.log("Items in the stack: ",this._executionStack);
	try {
	  // It would be good to update the database with the info about what we're going to try before trying it, so if there's a fatal error we can take a look at what might have caused it
	  // However, that data's not available until after the items on the exectution stack have been executed
	  while(this._executionStack.length) {
		possibleNewId = this._executionStack.shift().call();
		if (_.isString(possibleNewId)) {
		  newIdValues.push(possibleNewId);
		}
	  }
	  if (newIdValues.length === 1) {
		newId = newIdValues[0];	
	  }
	  else if (newIdValues.length > 1) {
		newId = newIdValues;	
	  }
	  Transactions.update({_id:this._transaction_id},{$set:_.extend({context:this._context},{items:this._items})});
	  this._lastTransactionData.writes = this._items;
	}
	catch(err) {
	  this.log(err);
	  this.log("Rolling back changes");
	  this.rollback();
	  this._callback(txid,callback,new Meteor.Error('error','An error occurred, so transaction was rolled back.',err),false);
	  return; 
	}
  }
  this._cleanReset();
  this.log("Commit reset transaction manager to clean state");
  this._callback(txid,callback,null,newId || true);
  return true; // A flag that at least one action was executed
}

// You can programatically call a rollback if you need to

Transact.prototype.rollback = function() {
  // Need to undo all the instant stuff that's been done
  var self = this;
  var items = this._items;
  var error = false;
  if (_.isArray(items.removed)) {
	_.each(items.removed, function(obj) {
	  if (obj.instant) {
		try {
		  if (obj.doc) {
			// This was removed from the collection, we need to reinsert it
			tx.collectionIndex[obj.collection].insert(obj.doc);
		  }
		  else {
			// This was soft deleted, we need to remove the deleted field
			tx.collectionIndex[obj.collection].update({_id:obj._id},{$unset:{deleted:1,transaction_id:self._transaction_id}});
		  }
		  self.log('Rolled back remove');
		}
		catch (err) {
		  self.log(err);
		  error = true;
		}
	  }
	});
  }
  if (_.isArray(items.updated)) {
	_.each(items.updated, function(obj) {// console.log("Undoing update: ", obj);
	  if (obj.instant && typeof obj.inverse !== 'undefined' && obj.inverse.command && obj.inverse.data) {
		var operation = {};
		operation[obj.inverse.command] = self._unpackageForUpdate(obj.inverse.data); // console.log(operation);
		try {  
		  tx.collectionIndex[obj.collection].update({_id:obj._id},operation);
		  self.log('Rolled back update');
		}
		catch (err) {
		  self.log(err);
		  error = true;
		}
	  }
	});
  }
  if (_.isArray(items.inserted)) {
	_.each(items.inserted, function(obj) {
	  if (obj.instant) {
		var sel = {_id:obj._id};
		// This transaction_id check is in case the document has been subsequently edited -- in that case, we don't want it removed from the database completely
		sel.transaction_id = self._transaction_id;
		try {
		  tx.collectionIndex[obj.collection].remove(sel);
		  self.log('Rolled back insert');
		}
		catch (err) {
		  self.log(err);
		  error = true;
		}
	  }
	});
  }
  if (error) {
	this.log("Rollback failed -- you'll need to check your database manually for corrupted records.");
	this.log("Here is a log of the actions that were tried and their inverses:");
	this.log("(it was probably one of the inverse actions that caused the problem here)");
	this.log(items);	
  }
  Transactions.remove({_id:this._transaction_id});
  self._cleanReset();
  this.log("Rollback reset transaction manager to clean state");
}

// Queue an insert

Transact.prototype.insert = function(collection,newDoc,opt,callback) {
  if (this._rollback || (tx.requireUser && !Meteor.userId())) {
	return;	
  }
  // We need to pass the options object when we do the actual insert
  // But also need to identify any callback functions
  var callback = (_.isFunction(callback)) ? callback : ((typeof opt !== 'undefined') ? ((_.isFunction(opt)) ? opt : ((_.isFunction(opt.callback)) ? opt.callback : undefined)) : undefined);
  if (opt && _.isObject(opt.tx)) {
	opt = opt.tx;
  }
  opt = (_.isObject(opt)) ? _.omit(opt,'tx') : undefined; // This is in case we're going to pass this options object on to, say, collection2 (tx must be gone or we'll create an infinite loop)
  // NOTE: "collection" is the collection object itself, not a string
  if (this._permissionCheckOverridden(opt) || this._permissionCheck("insert",collection,newDoc,{})) {
	var self = this;
	this._openAutoTransaction('add ' + collection._name.slice(0, - 1));
	self._setContext((opt && opt.context) || self.makeContext('insert',collection,newDoc,{}));
	if ((typeof opt !== 'undefined' && opt.instant) || this._autoTransaction) {
	  try {
		var newId = doInsert(collection,_.extend(newDoc,{transaction_id:self._transaction_id}),opt,callback);
		self._pushToRecord("inserted",collection,newId,{newDoc:newDoc},true); // true is to mark this as an instant change
		this._closeAutoTransaction(opt,callback,newId);
		this.log("Executed instant insert");
		return newId;
	  }
	  catch(err) {
		this.log(err);
		this.log("Rollback initiated by instant insert command");
		this._rollback = true;
		this._rollbackReason = 'insert-error';
	  }
	}
	this._executionStack.push(function() {
	  var newId = doInsert(collection,_.extend(newDoc,{transaction_id:self._transaction_id}),opt,callback);
	  self._pushToRecord("inserted",collection,newId,{newDoc:newDoc});
	  self.log("Executed insert");
	  return newId;
	});
	this.log("Pushed insert command to stack: " + this._transaction_id); //  + ' (Auto: ' + this._autoTransaction + ')'
	this._closeAutoTransaction(opt,callback);
	return !this._rollback; // Insert queued for execution (if it was executed the new _id value would already have been returned
  }
  else {
	this._rollback = true;
	this._rollbackReason = 'permission-denied';
	this.log("Insufficient permissions to insert this document into " + collection._name + ':', newDoc); // Permission to insert not granted
	return;	
  }
  
  function doInsert(collection,newDoc,opt,callback) {
	// The following is a very sketchy attempt to support collection2 options
	// Still requires aldeed:collection2 to be after babrahams:transactions in .packages
	if (_.isFunction(collection.attachSchema) && _.find(["validationContext","validate","filter","autoConvert","removeEmptyStrings","getAutoValues","replace","upsert","extendAutoValueContext","trimStrings","extendedCustomContext","transform"],function(c2option){ return typeof opt[c2option] !== "undefined";})) {
	  // This is a brutal workaround to allow collection2 `filter:false` to do its work
	  var newId = null;
	  var error = null;
	  collection.insert(newDoc,opt,function(err,newId) { 
		if (!err) {
		  newId = newId;	
		}
		else {
		  error = err;	
		}
	  });
	  if (_.isFunction(callback)) { // Let the app handle the error via its own callback
		callback(error,newId);
	  }
	  if (newId) {
	    return newId;
	  }
	  else {
		throw new Meteor.Error('Insert failed: ' + (error && error.message || 'reason unknown.'),(error && error.reason || ''));  
	  }
	}
	else {
	  return collection.insert(newDoc,callback);
	}
  }
}

// Queue a remove

Transact.prototype.remove = function(collection,doc,opt,callback) {
  // Remove any document with a field that has this val
  // NOTE: "collection" is the collection object itself, not a string
  if (this._rollback || (tx.requireUser && !Meteor.userId())) {
	return;	
  }
  // We need to pass the options object when we do the actual remove
  // But also need to identify any callback functions
  var callback = (_.isFunction(callback)) ? callback : ((typeof opt !== 'undefined') ? ((_.isFunction(opt)) ? opt : ((_.isFunction(opt.callback)) ? opt.callback : undefined)) : undefined);
  if (opt && _.isObject(opt.tx)) {
	opt = opt.tx;
  }
  var _id = (_.isObject(doc)) ? doc._id : doc;
  var existingDoc = (!_.isObject(doc)) ? collection.findOne({_id:doc}) : doc;
  if (this._permissionCheckOverridden(opt) || this._permissionCheck("remove",collection,existingDoc,{})) {
	var self = this;
	this._openAutoTransaction('remove ' + collection._name.slice(0, - 1));
	var sel = {_id:_id};
	if (Meteor.isServer) {
	  sel.deleted = {$exists: false}; // Can only do removes on client using a simple _id selector
	}
	self._setContext((opt && opt.context) || self.makeContext('remove',collection,existingDoc,{}));
	if (opt && opt.instant) {
	  try {
		doRemove(collection,_id,sel,true,opt,callback);
		this.log("Executed instant remove");
	  }
	  catch(err) {
		this.log(err);
		this.log("Rollback initiated by instant remove command");
		this._rollback = true;
		this._rollbackReason = 'remove-error';
	  }
	}
	else {
	  this._executionStack.push(function() {
		doRemove(collection,_id,sel,false,opt,callback);
		self.log('Executed remove');
	  });
	  this.log("Pushed remove command to stack: " + this._transaction_id); //  + ' (Auto: ' + this._autoTransaction + ')'
	}
	this._closeAutoTransaction(opt,callback);
	return !this._rollback; // Remove was executed or queued for execution
  }
  else {
	this._rollback = true;
	this._rollbackReason = 'permission-denied';
	this.log("Insufficient permissions to remove this document from " + collection._name + ':', existingDoc); // Permission to remove not granted
	return;
  }
  
  function doRemove(collection,_id,sel,instant,opt,callback) {
	if (!_.isFunction(callback)) {
	  callback = undefined;  
	}
	if (opt && ((typeof opt.softDelete !== 'undefined' && opt.softDelete) || (typeof opt.softDelete === 'undefined' && tx.softDelete))) {
	  self._pushToRecord("removed",collection,_id,null,instant);
	  collection.update(sel,{$set:{deleted:(new Date).getTime(),transaction_id:self._transaction_id}},callback);
	  return;
	}
	// Hard delete document
	var fullDoc = collection.findOne(sel);
	self._pushToRecord("removed",collection,_id,{doc:fullDoc},instant); // null is for field data (only used for updates) and true is to mark this as an instant change
	collection.remove(sel,callback);
  }
}

// Queue an update

Transact.prototype.update = function(collection,doc,updates,opt,callback) {
  // NOTE: "field" should be of the form {$set:{field:value}}, etc.
  // NOTE: "collection" is the collection object itself, not a string
  if (this._rollback || (tx.requireUser && !Meteor.userId())) {
	return;	
  }
  // We need to pass the options object when we do the actual update
  // But also need to identify any callback functions
  var callback = (_.isFunction(callback)) ? callback : ((typeof opt !== 'undefined') ? ((_.isFunction(opt)) ? opt : ((_.isFunction(opt.callback)) ? opt.callback : undefined)) : undefined);
  if (opt && _.isObject(opt.tx)) {
	opt = opt.tx;
  }
  var opt = (_.isObject(opt)) ? _.omit(opt,'tx') : undefined;
  var self = this;
  var _id = (_.isObject(doc)) ? doc._id : doc;
  var existingDoc = collection.findOne({_id:_id});
  // var existingDoc = (!_.isObject(doc)) ? collection.findOne({_id:_id}) : doc;
  // the above is slightly more efficient, in that it doesn't hit the database again
  // but potential buggy behaviour if a partial doc is passed and the field being updated
  // isn't in it and it's a $set command and so the inverse is wrongly taken to be $unset
  if (this._permissionCheckOverridden(opt) || this._permissionCheck("update", collection, existingDoc, updates)) {
	this._openAutoTransaction('update ' + collection._name.slice(0, - 1));
	var actionFields = _.pairs(updates); // console.log(actionField);
	var actionFieldsCount = actionFields.length;
	for (var i = 0; i < actionFieldsCount; i++) {
	  var command = actionFields[i][0]; // console.log("command:",command);
	  var updateMap = actionFields[i][1]; // console.log("updateMap:",updateMap);
	  if (typeof opt === 'undefined' || typeof opt.inverse === 'undefined') {
		// This "opt.inverse" thing is only used if you need to define some tricky inverse operation, but will probably not be necessary in practice
		// a custom value of opt.inverse needs to be an object of the form:
		// {command:"$set",data:{fieldName:value}}
		// var fieldName = _.keys(actionField[0][1])[0]; // console.log(fieldName);
		if (typeof opt === 'undefined') {
		  opt = {};	
		}
		var inverseCommand = this._inverseOps[command];
		var formerValues = {};
		switch (inverseCommand) { // In case we need to do something special to make the inverse happen
		  default :
			// TODO
		  case '$inc' :
		  case '$unset' :
		  case '$set' :
			_.each(_.keys(updateMap), function(keyName) {
			  var formerVal = self._drillDown(existingDoc,keyName);
			  if (typeof formerVal !== 'undefined') {
				formerValues[keyName] = formerVal;
			  }
			  else {
				inverseCommand = '$unset';
				formerValues[keyName] = '';
			  }
			});
			break;
		  case '$pull' :
			formerValues = updateMap;
			break;
		  /*case '$push' :
			formerValues = updateMap;
			break;*/
		  case '$addToSet' :
			formerValues = updateMap;
			break;
		  case '$pullAll' :
			// TODO
			break;
		  case '$pushAll' :
			// TODO
			break;
		}
		var inverse = {command:inverseCommand,data:formerValues}; // console.log("inverse op: ",opt.inverse);
	  }
	  else {
		var inverse = opt.inverse;	
	  }
	  self._setContext((opt && opt.context) || self.makeContext('update',collection,existingDoc,updates));
	  var updateData = {command:command, data:updateMap};
	  if (opt && opt.instant) {
		try {
		  makeUpdate(collection,_id,updates,updateData,inverse,true,opt,callback);
		  this.log("Executed instant update"); // true param is to record this as an instant change
		}
		catch(err) {
		  this.log(err);
		  this.log("Rollback initiated by instant update command");
		  this._rollback = true;
		  this._rollbackReason = 'update-error';
		}
	  }
	  else {
		this._executionStack.push(function() {
		  makeUpdate(collection,_id,updates,updateData,inverse,false,opt,callback);
		  self.log("Executed update");
		});
		this.log("Pushed update command to stack: " + this._transaction_id); //  + ' (Auto: ' + this._autoTransaction + ')'
	  }
	}
	this._closeAutoTransaction(opt,callback);
	return !this._rollback; // Update was executed or queued for execution
  }
  else {
	this._rollback = true;
	this._rollbackReason = 'permission-denied';
	this.log("Insufficient permissions to update this document in " + collection._name + ':', existingDoc); // Permission to update not granted
	return;
  }
  
  function makeUpdate(collection,_id,updates,updateData,inverseData,instant,opt,callback) {
	if (!_.isFunction(callback)) {
	  callback = undefined;
	}
	if (_.isObject(updates["$set"])) {
	  _.extend(updates["$set"], {transaction_id:self._transaction_id});
	}
	else {
	  updates["$set"] = {transaction_id:self._transaction_id};
	}
	// This error, handler business is to allow collection2 `filter:false` to do its work
	var error = null;
	var handler = function(err,res) {
	  if (err) {
		error = err;  
	  }
	  if (_.isFunction(callback)) {
	    callback(err,res);
	  }
	}
	if (_.isObject(opt)) {
	  collection.update({_id:_id},updates,opt,handler);
	}
	else {
	  collection.update({_id:_id},updates,handler);	
	}
	if (error) {
	  throw new Meteor.Error('Update failed: ' + error.message, error.reason);
	  return;
	}
	delete updates["$set"].transaction_id;
	self._pushToRecord("updated",collection,_id,{update:self._packageForStorage(updateData),inverse:self._packageForStorage(inverseData)},instant);
  }
  
}

// Cancel a transaction, but don't roll back immediately
// When the transaction is committed, no queued actions will be executed and any instant updates, inserts or removes that were made will be rolled back

Transact.prototype.cancel = function() {
  this.log('Transaction cancelled');
  this._rollback = true;
  this._rollbackReason = 'transaction-cancelled';
}

// Undo the last transaction by the user

Transact.prototype.undo = function( id ) {
  var self = this;
  Meteor.call("_meteorTransactionsUndo", id, function(err,res) {
	if (Meteor.isClient && res) {
	  self.onTransactionExpired.call();
	}
  });
}

// Redo the last transaction undone by the user

Transact.prototype.redo = function( id ) {
  var self = this;
  Meteor.call("_meteorTransactionsRedo", id, function(err,res) {
	if (Meteor.isClient && res) {
	  self.onTransactionExpired.call();  
	}
  });
}

// **********************************************************
// INTERNAL METHODS - NOT INTENDED TO BE CALLED FROM APP CODE
// **********************************************************

// This is used to check that the document going into the transactions collection has all the necessary fields

Transact.prototype._checkTransactionFields = function (modifier) {
 // Iterate over all the items that are going to be stored on the transaction stack and check their legitimacy
 var self = this,details,recombinedFields = {};
 var fields = modifier["$set"];
 if (!fields) {
   return false;
 }
 var items = fields.items;
 if (!items || _.isEmpty(items)) {
   return false; 
 }
 var action,collection,doc, fail = false;
 _.each(items,function(val,key) {
   _.each(val, function(value) {
	 if (value.update) {
	   action = 'update';
	   details = value.update;
	   recombinedFields[details.command] = self._unpackageForUpdate(details.data);
	 }
	 else if (value.insert) {
	   action = 'insert';  
	 }
	 else if (value.remove) {
	   action = 'remove';   
	 }
	 collection = value.collection;
	 doc = self.collectionIndex[collection].findOne({_id:value._id});
	 if (!self._permissionCheck(action,self.collectionIndex[collection],doc,recombinedFields)) {
	   fail = true;
	 }
   });
 });
 this._cleanReset(); // console.log("Fail: ",fail);
 return !fail;
}

// Reset everything to a clean state

Transact.prototype._cleanReset = function() {
  this._transaction_id = null;
  this._autoTransaction = false;
  this._items = {};
  this._executionStack = [];
  this._startAttempts = 0;
  this._granted = {};
  this._rollback = false;
  this._rollbackReason = '';
  this._context = {};
  // Note: we don't reset this._lastTransactionData because we want it to be available AFTER the commit
  if (Meteor.isServer) {
	Meteor.clearTimeout(this._autoCancel);
  }
}

Transact.prototype._callback = function(a,b,err,res) {
  var c = (_.isFunction(a)) ? a : ((_.isFunction(b)) ? b : null);
  if (c) {
	c.call(this._lastTransactionData,err,res);
  }  
}

// Starts a transaction automatically if one isn't started already

Transact.prototype._openAutoTransaction = function(description) {// console.log("Auto open check value for transaction_id: " + this._transaction_id + ' (Auto: ' + this._autoTransaction + ')');
  if (!this._transaction_id) {
	this._autoTransaction = true;
	this.start(description);
	// console.log("Auto opened: " + this._transaction_id + ' (Auto: ' + this._autoTransaction + ')');
  }
}

// Commits a transaction automatically if it was started automatically

Transact.prototype._closeAutoTransaction = function(opt,callback,newId) {// console.log("Auto commit check value for autoTransaction: " + this._autoTransaction + ' (Auto: ' + this._autoTransaction + ')');
  if (this._autoTransaction) {
	this.log("Auto committed: " + this._transaction_id); // + ' (Auto: ' + this._autoTransaction + ')';
	this.commit(opt,undefined,newId);	
  }
}

// Cancels and commits a transaction automatically if it exceeds the idleTimeout threshold with no new actions

Transact.prototype._resetAutoCancel = function() {
  if (Meteor.isServer) {
	var self = this;
	Meteor.clearTimeout(this._autoCancel);
	this._autoCancel = Meteor.setTimeout(function() {
	  self.log('Transaction (' + self._transaction_id + ') was cancelled after being inactive for ' + (self.idleTimeout / 1000) + ' seconds.');
	  self.rollback();
	},this.idleTimeout);
  }
}

// Pushes the record of a single action to the "items" sub document that is going to be recorded in the transactions collection along with data about this transaction

Transact.prototype._pushToRecord = function(type, collection, _id, fieldData, instant) {
  var item = {collection:collection._name,_id:_id};
  if (typeof instant !== 'undefined' && instant) {
	item.instant = true;	
  }
  if (typeof fieldData !== "undefined" && fieldData) {
	_.extend(item, fieldData);	
  }
  if (typeof this._items[type] === 'undefined') {
	this._items[type] = [];	
  }
  this._items[type].push(item);
  this._resetAutoCancel();
}

// Checks whether the permission check should be waived

Transact.prototype._permissionCheckOverridden = function(opt) {
  return typeof opt !== 'undefined' && opt.overridePermissionCheck;
}

// Uses a user-defined permission check as to whether this action is allowed or not

Transact.prototype._permissionCheck = function(action,collection,doc,updates) { // insert and remove send null for "updates" param, but this is where all the details of any update are found
  return this.checkPermission(action,collection,doc,updates);
}

// Builds the context object

Transact.prototype._setContext = function(context) {
  _.extend(this._context,context);  
}

// This turns the data that has been stored in an array of key-value pairs into an object that mongo can use in an update

Transact.prototype._unpackageForUpdate = function(data) {
  var objForUpdate = {};
  _.each(data, function(val) {
	objForUpdate[val.key] = val.value;
  });
  return objForUpdate;
}

// This turns the data that is given as a mongo update into an array of key-value pairs that can be stored
  
Transact.prototype._packageForStorage = function(update) {
  var arrForStorage = [];
  _.each(update.data, function(value,key) {
	arrForStorage.push({key:key,value:value});
  });
  return {command:update.command,data:arrForStorage};
  
}

// Given a dot delimited string as a key, and an object, find the value

Transact.prototype._drillDown = function(obj,key) {
  var pieces = key.split('.');
  if (pieces.length > 1) {
	var newObj = obj ? obj[pieces[0]] : {};
	pieces.shift();
	return this._drillDown(newObj,pieces.join('.'));
  }
  else {
	if (obj) {
	  return obj[key];
	}
	else {
	  return; // undefined	
	}	
  }
}

// This (tx) is the object that gets exported for the app to interact with

if (typeof tx === 'undefined') {
  tx = new Transact();
  tx.Transactions = Transactions; // Expose the Transactions collection via tx
}
else {
  throw new Meteor.Error('`tx` is already defined in the global scope. The babrahams:transactions package won\'t work.');  
}

// These are the methods that actually do the undo and redo work
// They should not be called directly -- use tx.undo() and tx.redo()

Meteor.methods({
  
  '_meteorTransactionsUndo' : function( id ) {
	if (tx.requireUser && !Meteor.userId()) {
	  console.log('You must be logged in to undo actions.');
	  return;
	}
	// Get the latest transaction done by this user and undo it
	var expired = false;
	var queuedItems = [];
	var lastTransaction;
	if (id){
		lastTransaction = Transactions.find({_id: id}, {sort: {timestamp: -1}, limit:1}).fetch()[0];
	} else {
		lastTransaction = Transactions.find({user_id:Meteor.userId(), $or:[{undone:null}, {undone:{$exists: false}}], expired: {$exists: false}}, {sort: {timestamp: -1}, limit:1}).fetch()[0];
	}
	if (lastTransaction && typeof lastTransaction.items !== 'undefined') {
	  if (_.isArray(lastTransaction.items.removed)) {
		_.each(lastTransaction.items.removed, function(obj) {
		  if (obj.doc) {
			// This doc is here because the original was removed
			// First check for duplicates -- if there is one, the transaction has expired
			if (tx.collectionIndex[obj.collection].find(obj.doc._id).count()) {
			  expired = true;  
			}
			else {
		      queuedItems.push(function(){
			    tx.collectionIndex[obj.collection].insert(obj.doc);
			  });
			}
		  }
		  else {
			// This was removed with softDelete
			queuedItems.push(function(){
			  tx.collectionIndex[obj.collection].update({_id:obj._id},{$unset:{deleted:1,transaction_id:lastTransaction._id}});
			});
		  }
		});
	  }
	  if (_.isArray(lastTransaction.items.updated)) {
		_.each(lastTransaction.items.updated, function(obj) {// console.log("Undoing update: ", obj);
		  if (typeof obj.inverse !== 'undefined' && obj.inverse.command && obj.inverse.data) {
			var operation = {};
			operation[obj.inverse.command] = tx._unpackageForUpdate(obj.inverse.data);// console.log(operation);
			queuedItems.push(function(){tx.collectionIndex[obj.collection].update({_id:obj._id},operation)});
		  }
		});
	  }
	  if (_.isArray(lastTransaction.items.inserted)) {
		_.each(lastTransaction.items.inserted, function(obj) {
		  var sel = {_id:obj._id};
		  // This transaction check is in case the document has been subsequently edited -- in that case, we don't want it removed from the database completely
		  // Instead, we remove this transaction from the visible list by setting expired to true
		  sel.transaction_id = lastTransaction._id;
		  queuedItems.push(function(){tx.collectionIndex[obj.collection].remove(sel)});
		  if (tx.collectionIndex[obj.collection].findOne({_id:obj._id,$and:[{transaction_id:{$exists:true}},{transaction_id:{$ne:lastTransaction._id}}]})) {
			// Transaction has expired
			Transactions.update({_id:lastTransaction._id},{$set:{expired:true}});
			expired = true; // This is to tell the client that the transaction has expired and the undo was not executed
		  }
		});
	  }
	  // After an undo, we need to remove that transaction from the stack
	  if (!expired) {
		// Process queue
		_.each(queuedItems,function(queuedItem) {
		  queuedItem.call(); 
		});
		Transactions.update({_id:lastTransaction._id},{$set:{undone:(new Date).getTime()}});
	  }
	}
	else if (lastTransaction) {
	  // Auto clean - this transaction is empty
	  Transactions.remove({_id:lastTransaction._id});	
	}
	return expired; // If the function returns true, the undo failed
  },
  
  '_meteorTransactionsRedo' : function( id ) {
	if (tx.requireUser && !Meteor.userId()) {
	  console.log('You must be logged in to redo actions.');
	  return;
	}
	// Get the latest undone transaction by this user and redo it
	var expired = false;
	var queuedItems = [];
	var lastUndo;
	if (id){
		lastUndo = Transactions.find({_id: id}, {sort: {timestamp: -1}, limit:1}).fetch()[0];
	} else {
		lastUndo = Transactions.find({user_id:Meteor.userId(), undone:{$exists:true, $ne: null}, expired:{$exists:false}}, {sort: {undone: -1}, limit:1}).fetch()[0];
	}
	if (lastUndo && typeof lastUndo.items !== 'undefined') {
	  if (_.isArray(lastUndo.items.removed)) {
		_.each(lastUndo.items.removed, function(obj) {
		  if (obj.doc) {
			// This document was removed using a hard	delete the first time
			// We'll hard delete again, make no attempt to save any modifications that have happened to the document in the interim
			queuedItems.push(function(){tx.collectionIndex[obj.collection].remove({_id:obj._id})});
		  }
		  else {
			queuedItems.push(function(){tx.collectionIndex[obj.collection].update({_id:obj._id},{$set:{deleted:(new Date).getTime(),transaction_id:lastUndo._id}})});
		  }
		});
	  }
	  if (_.isArray(lastUndo.items.updated)) {
		_.each(lastUndo.items.updated, function(obj) {// console.log("Redoing update: ", obj);
		  if (typeof obj.update !== 'undefined' && obj.update.command && obj.update.data) {
			var operation = {};
			operation[obj.update.command] = tx._unpackageForUpdate(obj.update.data);// console.log(operation);
			queuedItems.push(function(){tx.collectionIndex[obj.collection].update({_id:obj._id},operation)});
		  }
		});
	  }
	  if (_.isArray(lastUndo.items.inserted)) {
		_.each(lastUndo.items.inserted, function(obj) {
		  if (!tx.collectionIndex[obj.collection].find({_id:obj._id}).count()) {
			var newDoc = _.extend(obj.newDoc,{transaction_id:lastUndo._id,_id:obj._id});
			queuedItems.push(function(){tx.collectionIndex[obj.collection].insert(newDoc)});
		  }
		  else {
			// This is an edited doc that was not removed on last undo
			// Transaction has expired
			Transactions.update({_id:lastUndo._id},{$set:{expired:true}});
			expired = true; // This is to tell the client that the transaction has expired and the reodo was not executed
		  }
		});
	  }
	  // After a redo, we need to add that transaction to the stack again
	  if (!expired) {
		// Process queue
		_.each(queuedItems,function(queuedItem) {
		  queuedItem.call(); 
		});
		Transactions.update({_id:lastUndo._id},{$unset:{undone:1}}); // ,$set:{timestamp:(new Date).getTime()} -- LEADS TO UNEXPECTED RESULTS
	  }
	}
	return expired; // If the function returns true, the redo failed
  }
  
});


// Wrap DB write operation methods
// Wrapping technique shamelessly stolen from aldeed:collection2 codebase
// (https://github.com/aldeed/meteor-collection2/blob/master/collection2.js) and modified for this package

// backwards compatibility
if (typeof Mongo === "undefined") {
  Mongo = {};
  Mongo.Collection = Meteor.Collection;
}

_.each(['insert', 'update', 'remove'], function(methodName) {
  var _super = Mongo.Collection.prototype[methodName];
  Mongo.Collection.prototype[methodName] = function () {
	var self = this, args = _.toArray(arguments); // self is the Mongo.Collection instance
	var optionsArg = (methodName === 'update') ? 2 : 1;
	if (_.isObject(args[optionsArg]) && args[optionsArg].tx) {
	  args.unshift(self);
	  return tx[methodName].apply(tx,args);
	}
	return _super.apply(self, args);
  };
});

// Here we ensure the the tx object is aware of the apps collections and can access them by name
// we use dburles:mongo-collection-instances package to do this.
// We also check for the presence of SimpleSchema and extend the schema of existing
// collections to allow for the fields that transactions will add to documents

Meteor.startup(function() {
  Meteor.defer(function() {
    tx.collectionIndex = _.reduce(Mongo.Collection.getAll(),function(memo,coll) { memo[coll.name] = coll.instance; return memo; },{});
	if (typeof SimpleSchema !== 'undefined') {
	  SimpleSchema.debug = true;
	  _.each(tx.collectionIndex,function(collection) {
        if (_.isFunction(collection.simpleSchema)) {
          collection.attachSchema({deleted:{type:Number,label:"Deleted",optional:true},transaction_id:{type:String,label:"transaction_id",optional:true},_id:{type:String,label: "_id",optional:true}});
        }
	  });
	  if (_.isFunction(tx.Transactions.attachSchema)) {
		var userPattern = {
		  type:String,
		  label:"User Id"
		}
		if (!tx.requireUser) {
		  userPattern.optional = true;	
		}
		var TransactionSchema = new SimpleSchema({
		  "context": {
			type:Object,
			label:"Context",
			optional:true
		  },
		  "description": {
			type:String,
			label:"Description"
		  },
		  "items": {
			type:Object,
			label:"Items",
			blackbox:true,
			optional:true
		  },
		  "timestamp": {
			type:Number,
			label:"Timestamp"
		  },
		  "undone": {
			type:Number,
			label:"Undone",
			optional:true
		  },
		  "user_id": userPattern,
		  "expired": {
			type:Boolean,
			label:"Expired",
			optional:true
		  }
		});
		tx.Transactions.attachSchema(TransactionSchema);
	  }
	}
  });
});

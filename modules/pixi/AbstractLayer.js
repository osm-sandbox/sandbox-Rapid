
// Convert a single value, an Array of values, or a Set of values.
function asSet(vals) {
  if (vals instanceof Set) return vals;
  return new Set(vals !== undefined && [].concat(vals));
}


/**
 * AbstractLayer is the base class from which all Layers inherit.
 * It creates a container to hold the Layer data.
 *
 * Notes on identifiers:
 * All identifiers should be strings, to avoid JavaScript comparison surprises (e.g. `'0' !== 0`)
 *   `layerID`     A unique identifier for the layer, for example 'osm'
 *   `featureID`   A unique identifier for the feature, for example 'osm-w-123-fill'
 *   `dataID`      A feature may have data bound to it, for example OSM identifier like 'w-123'
 *   `classID`     A pseudoclass identifier like 'hover' or 'select'
 *
 * Properties you can access:
 *   `id`          Unique string to use for the name of this Layer
 *   `supported`   Is this Layer supported? (i.e. do we even show it in lists?)
 *   `zIndex`      Where this Layer sits compared to other Layers
 *   `enabled`     Whether the the user has chosen to see the Layer
 *   `features`    `Map<featureID, Feature>` of all features on this Layer
 *   `retained`    `Map<featureID, Integer frame>` last seen
 */
export class AbstractLayer {

  /**
   * @constructor
   * @param  {PixiScene}  scene   - The Scene that owns this Layer
   * @param  {string}     layerID - Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    this.scene = scene;
    this.gfx = scene.gfx;
    this.context = scene.context;
    this.layerID = layerID;

    this._enabled = false;  // Whether the user has chosen to see the layer

    // Collection of Features on this Layer
    this.features = new Map();     // Map<featureID, Feature>
    this.retained = new Map();     // Map<featureID, frame last seen>

    // Feature <-> Data
    // These lookups capture which features are bound to which data.
    this._featureHasData = new Map();    // Map<featureID, dataID>
    this._dataHasFeature = new Map();    // Map<dataID, Set<featureID>>

    // Parent Data <-> Child Data
    // We establish a parent-child data hierarchy (like what the DOM used to do for us)
    // For example, we need this to know which ways make up a multipolygon relation.
    this._parentHasChildren = new Map();  // Map<parent dataID, Set<child dataID>>
    this._childHasParents = new Map();    // Map<child dataID, Set<parent dataID>>

    // Data <-> Class
    // Data classes are strings (like what CSS classes used to do for us)
    // Counterintuitively, the Layer needs to be the source of truth for these data classes,
    // because a Feature can be 'selected' or 'drawing' even before it has been created, or after destroyed
    this._dataHasClass = new Map();     // Map<dataID, Set<classID>>
    this._classHasData = new Map();     // Map<classID, Set<dataID>>
  }


  /**
   * reset
   * Every Layer should have a reset function to replace any Pixi objects and internal state.
   * Override in a subclass with needed logic.
   * @abstract
   */
  reset() {
    this._featureHasData.clear();
    this._dataHasFeature.clear();
    this._parentHasChildren.clear();  // maybe don't clear this (should pseudo dom survive a reset?)
    this._childHasParents.clear();    // maybe don't clear this (should pseudo dom survive a reset?)
    this._dataHasClass.clear();       // maybe don't clear this (should pseudo css survive a reset?)
    this._classHasData.clear();       // maybe don't clear this (should pseudo css survive a reset?)

    for (const feature of this.features.values()) {
      feature.destroy();
    }

    this.features.clear();
    this.retained.clear();
  }


  /**
   * render
   * Every Layer should have a render function that manages the Features in view.
   * Override in a subclass with needed logic. It will be passed:
   * @param  {number}    frame    - Integer frame being rendered
   * @param  {Viewport}  viewport - Pixi viewport to use for rendering
   * @param  {number}    zoom     - Effective zoom to use for rendering
   * @abstract
   */
  render() {
  }


  /**
   * cull
   * Make invisible any Features that were not seen during the current frame
   * @param  {number}  frame - Integer frame being rendered
   */
  cull(frame) {
    for (const [featureID, feature] of this.features) {
      const seenFrame = this.retained.get(featureID);
      if (seenFrame === frame) continue;

      // Can't see it currently, make it invisible
      feature.visible = false;

      // Haven't seen it in a while, remove completely
      if (frame - seenFrame > 20) {
        feature.destroy();
      }
    }
  }


  /**
   * addFeature
   * Add a feature to the layer cache.
   * @param  {Feature} feature - A Feature derived from `AbstractFeature` (point, line, multipolygon)
   */
  addFeature(feature) {
    this.features.set(feature.id, feature);
  }


  /**
   * removeFeature
   * Remove a Feature from the layer cache.
   * @param  {Feature} feature - A Feature derived from `AbstractFeature` (point, line, multipolygon)
   */
  removeFeature(feature) {
    this.unbindData(feature.id);
    this.retained.delete(feature.id);
    this.features.delete(feature.id);
  }


  /**
   * retainFeature
   * Retain the feature for the given frame.
   * Features that are not retained may be automatically culled (made invisible) or removed.
   * @param  {Feature}  feature - A Feature derived from `AbstractFeature` (point, line, multipolygon)
   * @param  {number}   frame   - Integer frame being rendered
   */
  retainFeature(feature, frame) {
    if (feature.lod > 0) {
      feature.visible = true;
    }
    // If in user's view, retain it regardless of whether it's actually visible.
    // We want to avoid continuously creating invisible things just to dispose of them a few frames later.
    // For example points when zoomed out far.
    this.retained.set(feature.id, frame);
  }


  /**
   * bindData
   * Adds (or replaces) a data binding from featureID to a dataID
   * @param  {string}  featureID - featureID  (e.g. 'osm-w-123-fill')
   * @param  {string}  dataID    - dataID     (e.g. 'w-123')
   */
  bindData(featureID, dataID) {
    this.unbindData(featureID);

    let featureIDs = this._dataHasFeature.get(dataID);
    if (!featureIDs) {
      featureIDs = new Set();
      this._dataHasFeature.set(dataID, featureIDs);
    }
    featureIDs.add(featureID);

    this._featureHasData.set(featureID, dataID);
  }


  /**
   * unbindData
   * Removes the data binding for a given featureID
   * @param  {string} featureID - featureID  (e.g. 'osm-w-123-fill')
   */
  unbindData(featureID) {
    const dataID = this._featureHasData.get(featureID);
    if (!dataID) return;

    const featureIDs = this._dataHasFeature.get(dataID);
    if (featureIDs) {
      featureIDs.delete(featureID);

      // If no features are bound to this data anymore, remove all references to it.
      if (!featureIDs.size) {
        this._dataHasFeature.delete(dataID);
        this._parentHasChildren.delete(dataID);
        this._childHasParents.delete(dataID);
        // Note that we don't touch the data classes here..
        // e.g. if a selected feature leaves the scene and comes back later, it's still selected!
      }
    }

    this._featureHasData.delete(featureID);
  }


  /**
   * addChildData
   * Adds a mapping from parent data to child data.
   * @param  {string}  parentID - dataID of the parent (e.g. 'r123')
   * @param  {string}  childID  - dataID of the child (e.g. 'w123')
   */
  addChildData(parentID, childID) {
    let childIDs = this._parentHasChildren.get(parentID);
    if (!childIDs) {
      childIDs = new Set();
      this._parentHasChildren.set(parentID, childIDs);
    }
    childIDs.add(childID);

    let parentIDs = this._childHasParents.get(childID);
    if (!parentIDs) {
      parentIDs = new Set();
      this._childHasParents.set(childID, parentIDs);
    }
    parentIDs.add(parentID);
  }


  /**
   * removeChildData
   * Removes mapping from parent data to child data.
   * @param  {string} parentID - dataID (e.g. 'r123')
   * @param  {string} childID  - dataID to remove as a child (e.g. 'w1')
   */
  removeChildData(parentID, childID) {
    let childIDs = this._parentHasChildren.get(parentID);
    if (childIDs) {
      childIDs.delete(childID);
      if (!childIDs.size) {
        let child = this._parentHasChildren.get(childID);
        if (!child) {
          this._parentHasChildren.delete(childID);
        }
      }
    }

    let parentIDs = this._childHasParents.get(childID);
    if (parentIDs) {
      parentIDs.delete(childID);
      if (!parentIDs.size) {
        this._childHasParents.delete(childID);
      }
    }
  }


  /**
   * clearChildData
   * Removes all child dataIDs for the given parent dataID
   * @param  {string}  parentID - dataID (e.g. 'r123')
   */
  clearChildData(parentID) {
    const childIDs = this._parentHasChildren.get(parentID) ?? new Set();
    for (const childID of childIDs) {
      this.removeChildData(parentID, childID);
    }
  }


  /**
   * getSelfAndDescendants
   * Recursively get a result `Set` including the given dataID and all dataIDs in the child hierarchy.
   * @param  {string}       dataID  - dataID (e.g. 'r123')
   * @param  {Set<string>}  result? - `Set` containing the results (e.g. ['r123','w123','n123'])
   * @return {Set<string>}  `Set` including the dataID and all dataIDs in the child hierarchy
   */
  getSelfAndDescendants(dataID, result) {
    if (result instanceof Set) {
      result.add(dataID);
    } else {
      result = new Set([dataID]);
    }

    const childIDs = this._parentHasChildren.get(dataID) ?? new Set();
    for (const childID of childIDs) {
      if (!result.has(childID)) {
        this.getSelfAndDescendants(childID, result);
      }
    }

    return result;
  }


  /**
   * getSelfAndAncestors
   * Recursively get a result `Set` including the given dataID and all dataIDs in the parent hierarchy
   * @param  {string}       dataID  - dataID (e.g. 'n123')
   * @param  {Set<string>}  result? - `Set` containing the results (e.g. ['n123','w123','r123'])
   * @return {Set<string>}  `Set` including the dataID and all dataIDs in the parent hierarchy
   */
  getSelfAndAncestors(dataID, result) {
    if (result instanceof Set) {
      result.add(dataID);
    } else {
      result = new Set([dataID]);
    }

    const parentIDs = this._childHasParents.get(dataID) ?? new Set();
    for (const parentID of parentIDs) {
      if (!result.has(parentID)) {
        this.getSelfAndAncestors(parentID, result);
      }
    }

    return result;
  }


  /**
   * getSelfAndSiblings
   * Get a result `Set` including the dataID and all sibling dataIDs in the parent-child hierarchy
   * @param  {string}        dataID  - `String` dataID (e.g. 'n123')
   * @param  {Set<string>}   result? - `Set` containing the results (e.g. ['n121','n122','n123','n124'])
   * @return {Set<string>}  `Set` including the dataID and all dataIDs adjacent in the parent-child hierarchy
   */
  getSelfAndSiblings(dataID, result) {
    if (result instanceof Set) {
      result.add(dataID);
    } else {
      result = new Set([dataID]);
    }

    const parentIDs = this._childHasParents.get(dataID) ?? new Set();
    for (const parentID of parentIDs) {
      const siblingIDs = this._parentHasChildren.get(parentID) ?? new Set();
      for (const siblingID of siblingIDs) {
        result.add(siblingID);
      }
    }

    return result;
  }


  /**
   * setClass
   * Sets a dataID as being classed a certain way (e.g. 'hover')
   * @param  {string}  classID - classID to set (e.g. 'hover')
   * @param  {string}  dataID  - dataID (e.g. 'r123')
   */
  setClass(classID, dataID) {
    let classIDs = this._dataHasClass.get(dataID);
    if (!classIDs) {
      classIDs = new Set();
      this._dataHasClass.set(dataID, classIDs);
    }
    classIDs.add(classID);

    let dataIDs = this._classHasData.get(classID);
    if (!dataIDs) {
      dataIDs = new Set();
      this._classHasData.set(classID, dataIDs);
    }
    dataIDs.add(dataID);
  }


  /**
   * unsetClass
   * Unsets a dataID from being classed a certain way (e.g. 'hover')
   * @param  {string}  classID - classID to unset (e.g. 'hover')
   * @param  {string}  dataID  - dataID (e.g. 'r123')
   */
  unsetClass(classID, dataID) {
    let classIDs = this._dataHasClass.get(dataID);
    if (classIDs) {
      classIDs.delete(classID);
      if (!classIDs.size) {
        this._dataHasClass.delete(dataID);
      }
    }

    let dataIDs = this._classHasData.get(classID);
    if (dataIDs) {
      dataIDs.delete(dataID);
      if (!dataIDs.size) {
        this._classHasData.delete(classID);
      }
    }
  }


  /**
   * clearClass
   * Clear out all uses of the given classID.
   * @param  {string}  classID  - classID to clear (e.g. 'hover')
   */
  clearClass(classID) {
    const dataIDs = this._classHasData.get(classID) ?? new Set();
    for (const dataID of dataIDs) {
      this.unsetClass(classID, dataID);
    }
  }


  /**
   * getDataWithClass
   * Returns the dataIDs that are currently classed with the given classID
   * @param  {string}      classID - classID to check (e.g. 'hover')
   * @return {Set<string>} dataIDs the dataIDs that currently have this classID set
   */
  getDataWithClass(classID) {
    const dataIDs = this._classHasData.get(classID) ?? new Set();
    return new Set(dataIDs);  // copy
  }


  /**
   * syncFeatureClasses
   * This updates the feature's classes (e.g. 'select', 'hover', etc.) to match the Layer classes.
   *
   * Counterintuitively, the Layer needs to be the source of truth for these classes,
   * because a Feature can be 'selected' or 'drawing' even before it has been created, or after destroyed.
   *
   * Syncing these classes will dirty the feature if the it causes a change.
   * Therefore this should be called after the Feature has been created, but before any updates happen.
   *
   * @param  {Feature} feature - A Feature derived from `AbstractFeature` (point, line, multipolygon)
   */
  syncFeatureClasses(feature) {
    const featureID = feature.id;
    const dataID = this._featureHasData.get(featureID);
    if (!dataID) return;

    const layerClasses = this._dataHasClass.get(dataID) ?? new Set();
    const featureClasses = feature._classes;

    for (const classID of featureClasses) {
      if (layerClasses.has(classID)) continue;  // no change
      feature.unsetClass(classID);              // remove extra class from feature
    }
    for (const classID of layerClasses) {
      if (featureClasses.has(classID)) continue;  // no change
      feature.setClass(classID);                  // add missing class to feature
    }

    // Trying to document all the supported pseudoclasses here:
    //
    // 'drawing':  removes the hitarea, and avoids hover, e.g. it prevents snapping
    // 'highlight':  adds a blue glowfilter
    // 'hover':  adds a yellow glowfilter
    // 'select':  adds a dashed line halo
    // 'selectphoto':  styling for the currently selected photo
  }


  /**
   * dirtyLayer
   * Mark all features on this layer as `dirty`.
   * During the next "app" pass, dirty features will be rebuilt.
   */
  dirtyLayer() {
    for (const feature of this.features.values()) {
      feature.dirty = true;
    }
  }

  /**
   * dirtyFeatures
   * Mark specific features features as `dirty`
   * During the next "app" pass, dirty features will be rebuilt.
   * @param {Set<string>|Array<string>|string}  featureIDs - A `Set` or `Array` of featureIDs, or single `String` featureID
   */
  dirtyFeatures(featureIDs) {
    for (const featureID of asSet(featureIDs)) {   // coax ids into a Set
      const feature = this.features.get(featureID);
      if (feature) {
        feature.dirty = true;
      }
    }
  }

  /**
   * dirtyData
   * Mark any features bound to a given dataID as `dirty`
   * During the next "app" pass, dirty features will be rebuilt.
   * @param {Set<string>|Array<string>|string}  dataIDs - A `Set` or `Array` of dataIDs, or single `String` dataID
   */
  dirtyData(dataIDs) {
    for (const dataID of asSet(dataIDs)) {   // coax ids into a Set
      const featureIDs = this._dataHasFeature.get(dataID);
      if (featureIDs) {
        this.dirtyFeatures(featureIDs);
      }
    }
  }


  /**
   * Layer id
   * @readonly
   */
  get id() {
    return this.layerID;
  }


  /**
   * supported
   * Is this Layer supported? (i.e. do we even show it in lists?)
   * Can be overridden in a subclass with additional logic
   * @abstract
   */
  get supported() {
    return true;
  }


  /**
   * enabled
   * Whether the user has chosen to see the Layer
   */
  get enabled() {
    return this._enabled;
  }
  set enabled(val) {
    if (val === this._enabled) return;  // no change
    this._enabled = val;
    this.dirtyLayer();
  }

}

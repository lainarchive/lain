use std::collections::{BTreeMap, BTreeSet};

use crate::scope::WriteScope;

#[derive(Debug, Clone)]
pub struct Node {
    pub id: String,
    pub deps: Vec<String>,
    pub write_scope: WriteScope,
}

#[derive(Debug, thiserror::Error)]
pub enum DagError {
    #[error("empty or duplicate node id: {0}")]
    Duplicate(String),
    #[error("unknown dependency {dependency} of {node}")]
    Unknown { node: String, dependency: String },
    #[error("dependency cycle")]
    Cycle,
    #[error("concurrent nodes have overlapping write scopes: {0}, {1}")]
    Overlap(String, String),
}

#[derive(Debug, Clone)]
pub struct Dag {
    nodes: BTreeMap<String, Node>,
    layers: Vec<Vec<String>>,
}

impl Dag {
    pub fn new(nodes: Vec<Node>) -> Result<Self, DagError> {
        let mut map = BTreeMap::new();
        for node in nodes {
            let id = node.id.clone();
            if id.is_empty() || map.insert(id.clone(), node).is_some() {
                return Err(DagError::Duplicate(id));
            }
        }
        for node in map.values() {
            for dependency in &node.deps {
                if !map.contains_key(dependency) {
                    return Err(DagError::Unknown {
                        node: node.id.clone(),
                        dependency: dependency.clone(),
                    });
                }
            }
        }
        let mut ancestors: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut layers = vec![];
        while ancestors.len() < map.len() {
            let layer: Vec<String> = map
                .values()
                .filter(|n| {
                    !ancestors.contains_key(&n.id)
                        && n.deps.iter().all(|d| ancestors.contains_key(d))
                })
                .map(|n| n.id.clone())
                .collect();
            if layer.is_empty() {
                return Err(DagError::Cycle);
            }
            for id in &layer {
                if let Some(node) = map.get(id) {
                    let mut parents = BTreeSet::new();
                    for dep in &node.deps {
                        parents.insert(dep.clone());
                        if let Some(earlier) = ancestors.get(dep) {
                            parents.extend(earlier.iter().cloned());
                        }
                    }
                    ancestors.insert(id.clone(), parents);
                }
            }
            layers.push(layer);
        }
        for (id, a) in &map {
            for (other, b) in map.iter().filter(|(other, _)| *other > id) {
                let ordered = ancestors.get(id).is_some_and(|set| set.contains(other))
                    || ancestors.get(other).is_some_and(|set| set.contains(id));
                if !ordered && a.write_scope.overlaps(&b.write_scope) {
                    return Err(DagError::Overlap(id.clone(), other.clone()));
                }
            }
        }
        Ok(Self { nodes: map, layers })
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }
    pub fn layers(&self) -> Vec<Vec<&Node>> {
        self.layers
            .iter()
            .map(|layer| layer.iter().filter_map(|id| self.nodes.get(id)).collect())
            .collect()
    }
}

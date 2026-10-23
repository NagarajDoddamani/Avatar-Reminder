import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export default function AvatarScene({ state }) {
  const hostRef = useRef(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.set(0, 1.3, 4.8);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x5c6780, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(2, 4, 3);
    scene.add(key);

    let avatar = null;
    let mixer = null;
    let actions = {};
    let currentAction = null;
    const clock = new THREE.Clock();

    // Add public/domain-licensed avatar model at public/avatar.vrm.
    // This starter uses a procedural placeholder until a VRM is supplied.
    const placeholder = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xe3b18b, roughness: 0.85 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0x557f9b, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x273342, roughness: 0.8 });
    const shoes = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 });
    const sphere = (x, y, z, sx, sy, sz, material) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), material);
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); placeholder.add(mesh);
      return mesh;
    };
    sphere(0, 1.62, 0, 0.27, 0.31, 0.24, skin);
    sphere(0, 1.95, 0, 0.22, 0.23, 0.22, jacket);
    sphere(0, 1.22, 0, 0.3, 0.38, 0.18, pants);
    sphere(-0.18, 0.72, 0, 0.11, 0.38, 0.12, pants);
    sphere(0.18, 0.72, 0, 0.11, 0.38, 0.12, pants);
    sphere(-0.18, 0.28, 0.05, 0.15, 0.09, 0.23, shoes);
    sphere(0.18, 0.28, 0.05, 0.15, 0.09, 0.23, shoes);
    sphere(-0.31, 1.9, 0, 0.09, 0.33, 0.1, jacket);
    sphere(0.31, 1.9, 0, 0.09, 0.33, 0.1, jacket);
    scene.add(placeholder);
    avatar = placeholder;
    avatar.position.x = 0.0;

    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    loader.load('/avatar.vrm', (gltf) => {
      if (avatar) scene.remove(avatar);
      const vrm = gltf.userData.vrm;
      VRMUtils.rotateVRM0(vrm);
      avatar = vrm.scene;
      avatar.scale.setScalar(1.0);
      scene.add(avatar);
      mixer = new THREE.AnimationMixer(avatar);
      actions = {};
      for (const clip of gltf.animations || []) {
        const name = clip.name.toLowerCase();
        const key = name.includes('walk') ? 'walk' :
          name.includes('talk') ? 'talk' :
          name.includes('idle') ? 'idle' : name;
        actions[key] = mixer.clipAction(clip);
      }
    }, undefined, () => {
      // Missing avatar.vrm is expected on a fresh install; placeholder remains visible.
    });

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      if (mixer) mixer.update(delta);
      const current = stateRef.current;
      if (avatar) {
        if (current === 'walkingIn') {
          avatar.position.x = THREE.MathUtils.damp(avatar.position.x, 0, 2.5, delta);
          avatar.rotation.y = Math.sin(clock.elapsedTime * 3) * 0.04;
        } else if (current === 'walkingOut') {
          avatar.position.x = THREE.MathUtils.damp(avatar.position.x, 2.8, 2.5, delta);
        } else {
          avatar.position.x = THREE.MathUtils.damp(avatar.position.x, 0, 3, delta);
          avatar.position.y = 0.035 * Math.sin(clock.elapsedTime * 2);
          avatar.rotation.y = 0.06 * Math.sin(clock.elapsedTime);
        }
        const desired = current === 'walkingIn' || current === 'walkingOut' ? 'walk' :
          current === 'talking' ? 'talk' : 'idle';
        if (actions[desired] && currentAction !== actions[desired]) {
          currentAction?.fadeOut(0.2);
          currentAction = actions[desired];
          currentAction.reset().fadeIn(0.2).play();
        }
      }
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) material.dispose();
        }
      });
    };
  }, []);

  return <div className="avatar-canvas" ref={hostRef} aria-label="3D avatar preview" />;
}

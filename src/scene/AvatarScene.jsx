import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const stateClip = (state, walkingEnabled = true, reactionsEnabled = true) => {
  if (state === 'walking_in' || state === 'walking_out') return walkingEnabled ? 'walk' : 'idle';
  if (state.startsWith('reacting-') && !reactionsEnabled) return 'idle';
  if (state === 'reacting-done') return 'jump';
  if (state === 'reacting-snooze' || state === 'reacting-dismiss') return 'wave';
  return 'idle';
};

export default function AvatarScene({ state = 'hidden', arrivalReady = false, exitReady = false, avatarSize = 'medium', animationSpeed = 1, walkingEnabled = true, reactionsEnabled = true, onError, onAnimationComplete }) {
  const hostRef = useRef(null);
  const stateRef = useRef(state);
  const errorRef = useRef(onError);
  const completeRef = useRef(onAnimationComplete);
  const arrivalRef = useRef(arrivalReady), exitRef = useRef(exitReady);
  const sizeRef = useRef(avatarSize), speedRef = useRef(animationSpeed), walkingRef = useRef(walkingEnabled), reactionsRef = useRef(reactionsEnabled);
  const [failed, setFailed] = useState(false);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { errorRef.current = onError; }, [onError]);
  useEffect(() => { completeRef.current = onAnimationComplete; }, [onAnimationComplete]);
  useEffect(() => { arrivalRef.current = arrivalReady; }, [arrivalReady]);
  useEffect(() => { exitRef.current = exitReady; }, [exitReady]);
  useEffect(() => { sizeRef.current = avatarSize; }, [avatarSize]);
  useEffect(() => { speedRef.current = animationSpeed; }, [animationSpeed]);
  useEffect(() => { walkingRef.current = walkingEnabled; }, [walkingEnabled]);
  useEffect(() => { reactionsRef.current = reactionsEnabled; }, [reactionsEnabled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let renderer;
    let disposed = false;
    let frame = 0;
    let avatarRoot = null;
    let mixer = null;
    let currentAction = null;
    let transitionAction = null;
    let completionSentFor = '';
    const actions = new Map();
    const actionKeys = new WeakMap();
    const bones = [];
    let walkBones = [];
    let armBones = [];
    let headBones = [];
    let torsoBones = [];
    let proceduralFadeUntil = 0;
    const clock = new THREE.Clock();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight), 0.05, 40);
    camera.position.set(0, 1.2, 4.5);
    camera.lookAt(0, 1.05, 0);

    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(renderer.domElement);
    } catch (error) {
      setFailed(true);
      errorRef.current?.(`WebGL could not start: ${error.message}`);
      return undefined;
    }

    scene.add(new THREE.HemisphereLight(0xffffff, 0x566176, 2.0));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2.5, 4, 3.5);
    scene.add(keyLight);

    const lost = event => {
      event.preventDefault();
      if (!disposed) {
        setFailed(true);
        errorRef.current?.('The avatar graphics context was lost. Restart the app to restore the 3D character.');
      }
    };
    renderer.domElement.addEventListener('webglcontextlost', lost, false);

    const loader = new GLTFLoader();
    const modelUrl = new URL('./models/avatar.glb', window.location.href).href;
    loader.load(modelUrl, gltf => {
      if (disposed) return;
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(size.y) || size.y <= 0) {
        setFailed(true);
        errorRef.current?.('The GLB has no visible 3D character mesh.');
        return;
      }
      const modelGroup = new THREE.Group();
      const scale = 2.15 / size.y;
      model.scale.setScalar(scale);
      model.position.set(-((bounds.min.x + bounds.max.x) / 2) * scale, -bounds.min.y * scale, -((bounds.min.z + bounds.max.z) / 2) * scale);
      modelGroup.add(model);
      scene.add(modelGroup);
      avatarRoot = modelGroup;
      model.traverse(object => {
        if (object.isBone) bones.push({ bone: object, rotation: object.rotation.clone(), name: object.name.toLowerCase() });
        if (object.isMesh) {
          object.frustumCulled = true;
          if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.needsUpdate = true;
        }
      });
      walkBones = bones.filter(item => /thigh|upleg|upperleg|calf|shin|lowerleg|foot|ankle/.test(item.name));
      armBones = bones.filter(item => /upperarm|arm|shoulder|forearm|elbow|hand/.test(item.name));
      headBones = bones.filter(item => /head|neck/.test(item.name));
      torsoBones = bones.filter(item => /spine|chest/.test(item.name));

      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations || []) {
        const name = clip.name.toLowerCase();
        const key = name.includes('walk') ? 'walk' : name.includes('wave') ? 'wave' : name.includes('jump') ? 'jump' : name.includes('idle') ? 'idle' : null;
        if (key && !actions.has(key)) {
          const action = mixer.clipAction(clip);
          actions.set(key, action);
          actionKeys.set(action, key);
        }
      }
      mixer.addEventListener('finished', event => {
        const current = stateRef.current;
        const key = actionKeys.get(event.action);
        if (current.startsWith('reacting-') && key === stateClip(current) && completionSentFor !== current) {
          completionSentFor = current;
          completeRef.current?.(current);
        }
      });
      mixer.addEventListener('loop', event => {
        const current = stateRef.current;
        if (actionKeys.get(event.action) !== 'walk' || completionSentFor === current) return;
        if ((current === 'walking_in' && arrivalRef.current) || (current === 'walking_out' && exitRef.current)) {
          completionSentFor = current;
          completeRef.current?.(current);
        }
      });
      setFailed(false);
    }, undefined, error => {
      if (disposed) return;
      setFailed(true);
      errorRef.current?.(`Could not load public/models/avatar.glb: ${error?.message || 'file unavailable'}`);
    });

    let previousState = '';
    let stateStarted = 0;
    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      const current = stateRef.current;
      if (current !== previousState) {
        previousState = current;
        stateStarted = elapsed;
        completionSentFor = '';
      }
      if (mixer) mixer.update(delta * Math.max(0.5, Math.min(2, Number(speedRef.current) || 1)));

      const desired = stateClip(current, walkingRef.current, reactionsRef.current);
      const nextAction = actions.get(desired) || (desired !== 'idle' ? actions.get('idle') : null);
      if (nextAction !== currentAction) {
        if (currentAction) {
          currentAction.fadeOut(0.2);
          transitionAction = currentAction;
          if (!nextAction) proceduralFadeUntil = elapsed + 0.2;
        }
        currentAction = nextAction || null;
        if (currentAction) {
          currentAction.reset();
          if (desired === 'jump' || desired === 'wave') {
            currentAction.setLoop(THREE.LoopOnce, 1);
            currentAction.clampWhenFinished = true;
          } else currentAction.setLoop(THREE.LoopRepeat, Infinity);
          currentAction.fadeIn(0.18).play();
        }
      }

      if (avatarRoot) {
        const sizeFactor = sizeRef.current === 'small' ? 0.76 : sizeRef.current === 'large' ? 1.2 : 1;
        avatarRoot.scale.setScalar(sizeFactor);
        const phase = elapsed - stateStarted;
        const moveProgress = THREE.MathUtils.clamp(phase / 1, 0, 1);
        const walkDuration = currentAction?.getClip().duration || 1;
        const walkCycleProgress = currentAction ? (currentAction.time % walkDuration) / walkDuration : moveProgress;
        // The outer Electron window carries the in-place walk cycle across the
        // desktop. Keep the rig fixed inside its view so the feet do not double-slide.
        avatarRoot.position.x = 0;

        const isWalking = current === 'walking_in' || current === 'walking_out';
        const isTalking = current === 'talking';
        const hasDesiredClip = actions.has(desired);
        const usingProceduralPose = !hasDesiredClip;
        avatarRoot.position.y = !actions.has('idle') && !isWalking ? 0.018 * Math.sin(elapsed * 2.6) : 0;
        if (current === 'walking_in') {
          const turn = arrivalRef.current ? THREE.MathUtils.clamp((walkCycleProgress - 0.68) / 0.32, 0, 1) : 0;
          const turnEase = turn * turn * (3 - 2 * turn);
          // The model's forward axis is +Z. Entering travels from right to left,
          // so it must turn toward -X while walking, then face the user on arrival.
          avatarRoot.rotation.y = (-Math.PI / 2) * (1 - turnEase);
        } else if (current === 'walking_out') {
          const turn = THREE.MathUtils.clamp(moveProgress / 0.28, 0, 1);
          avatarRoot.rotation.y = (Math.PI / 2) * turn * turn * (3 - 2 * turn);
        } else avatarRoot.rotation.y = isTalking ? 0.018 * Math.sin(elapsed * 7) : 0;

        // Preserve AnimationMixer's pose. Restore the bind pose only after a clip has
        // completed its fade-out, so standing never snaps back from a walk frame.
        if (usingProceduralPose && !currentAction && elapsed >= proceduralFadeUntil) {
          for (const item of bones) item.bone.rotation.copy(item.rotation);
        }
        if (isWalking && !actions.has('walk')) {
          const gait = Math.sin(elapsed * 10);
          walkBones.forEach(item => {
            const side = item.name.endsWith('.l') ? 1 : -1;
            if (/upperleg|thigh/.test(item.name)) item.bone.rotation.x += gait * side * 0.38;
            else if (/lowerleg|calf|shin/.test(item.name)) item.bone.rotation.x += Math.max(0, -gait * side) * 0.62;
            else item.bone.rotation.x -= gait * side * 0.16;
          });
          armBones.forEach(item => { item.bone.rotation.x += gait * (item.name.endsWith('.l') ? -0.25 : 0.25); });
        }
        if (!actions.has('idle') && !isWalking) {
          torsoBones.forEach((item, index) => { item.bone.rotation.x += (index ? 0.008 : 0.014) * Math.sin(elapsed * 2.4); });
        }
        if (isTalking && headBones.length) headBones[0].bone.rotation.x += 0.045 * Math.sin(elapsed * 8);
        const reaction = current.startsWith('reacting-');
        if (reaction && !actions.has(current === 'reacting-done' ? 'jump' : 'wave') && armBones.length) {
          const pulse = Math.sin(Math.min(1, (elapsed - stateStarted) / 0.7) * Math.PI);
          const leftArm = armBones.filter(item => item.name.endsWith('.l'));
          const reactionArms = current === 'reacting-done' ? armBones : (leftArm.length ? leftArm : armBones.slice(0, 2));
          reactionArms.forEach((item, index) => {
            item.bone.rotation.z += (current === 'reacting-done' ? -0.75 : -0.8) * pulse;
            if (current !== 'reacting-done' && /lowerarm|forearm|hand/.test(item.name)) item.bone.rotation.x += 0.18 * Math.sin(elapsed * 13) * pulse;
          });
          if (headBones.length && current === 'reacting-dismiss') headBones[0].bone.rotation.y += 0.18 * pulse;
          if (current === 'reacting-done') avatarRoot.position.y += pulse * 0.18;
        }
        if (current === 'idle' && transitionAction && (!transitionAction.isRunning() || transitionAction.getEffectiveWeight() <= 0.01) && completionSentFor !== 'idle') {
          transitionAction = null;
          completionSentFor = 'idle';
          completeRef.current?.('idle');
        }
        if (current === 'walking_in' && arrivalRef.current && (!actions.has('walk') || !walkingRef.current) && phase >= 1 && completionSentFor !== current) {
          completionSentFor = current;
          completeRef.current?.(current);
        }
        if (current === 'walking_out' && exitRef.current && (!actions.has('walk') || !walkingRef.current) && phase >= 1 && completionSentFor !== current) {
          completionSentFor = current;
          completeRef.current?.(current);
        }
        if (reaction && (!actions.has(current === 'reacting-done' ? 'jump' : 'wave') || !reactionsRef.current) && phase >= 0.7 && completionSentFor !== current) {
          completionSentFor = current;
          completeRef.current?.(current);
        }
      }
      try { renderer.render(scene, camera); }
      catch (error) {
        setFailed(true);
        errorRef.current?.(`The avatar could not be rendered: ${error.message}`);
        cancelAnimationFrame(frame);
      }
    };
    animate();

    const resize = () => {
      if (disposed || !host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      mixer?.stopAllAction();
      if (avatarRoot && mixer) mixer.uncacheRoot(avatarRoot.children[0]);
      scene.traverse(object => {
        object.geometry?.dispose();
        const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
        for (const material of materials) {
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="avatar-canvas avatar-scene-host" ref={hostRef} aria-label="Animated 3D avatar">
    {failed && <div className="avatar-model-error" role="status">3D avatar unavailable. Check <code>public/models/avatar.glb</code>.</div>}
  </div>;
}

import React from 'react';
import { isSafeCustomImage } from '../../shared/customImage';
import { petOption, type PetId } from '../../shared/types';

/** 随机待机小动作：歪头 / 伸懒腰 / 看向一侧。 */
export type PetIdleAction = 'none' | 'tilt' | 'stretch' | 'peek';

interface PetProps {
  pet: PetId;
  customImage?: string;
  attentive?: boolean;
  thinking?: boolean;
  compact?: boolean;
  action?: PetIdleAction;
}

export function Pet({
  pet,
  customImage = '',
  attentive = false,
  thinking = false,
  compact = false,
  action = 'none',
}: PetProps) {
  const option = petOption(pet);
  const useCustom = pet === 'custom' && isSafeCustomImage(customImage);
  const label = useCustom ? '自定义形象' : option.label;

  let source = '';
  try {
    source = useCustom ? customImage : chrome.runtime.getURL(option.file);
  } catch {
    // 扩展上下文失效时保留占位，避免渲染报错。
  }

  return (
    <span
      className={`pup-pet ${attentive ? 'is-attentive' : ''} ${thinking ? 'is-thinking' : ''} ${compact ? 'is-compact' : ''} ${action !== 'none' ? `is-idle-${action}` : ''}`}
      role="img"
      aria-label={thinking ? `伴读${label}正在思考` : `一只安静的伴读${label}`}
      data-thinking={thinking ? 'idle,sniffing,chewing,wagging' : undefined}
    >
      {source && <img className="pup-pet-image" src={source} alt="" draggable={false} />}
      {thinking && (
        <span className="pup-think-bubble" aria-hidden="true"><i /><i /><i /></span>
      )}
    </span>
  );
}

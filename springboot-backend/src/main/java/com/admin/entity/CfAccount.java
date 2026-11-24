package com.admin.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import lombok.Data;

import java.io.Serializable;

/**
 * <p>
 * Cloudflare 账号(DNS 管理用)。
 * </p>
 *
 * 只存 token 的密文(token_aes),明文既不入库也不出接口 —— 面板是公网可访问的,
 * 一个能改 DNS 的 Cloudflare Token 权限很大(可以劫持域名解析)。
 *
 * @since 2026-11-25
 */
@Data
public class CfAccount implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 主键ID */
    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    /** 账号备注名(面板里显示用) */
    private String name;

    /** Cloudflare API Token 的 AES-GCM 密文 */
    private String tokenAes;

    /** 状态(1:启用) */
    private Integer status;

    /** 创建时间（毫秒时间戳） */
    private Long createdTime;

    /** 更新时间（毫秒时间戳） */
    private Long updatedTime;

}
